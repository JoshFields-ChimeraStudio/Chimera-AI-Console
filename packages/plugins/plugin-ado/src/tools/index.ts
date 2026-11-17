/**
 * A8: ADO tools for agents. All agent writes to ADO go through these tools,
 * which check the agent's role, attribute the write to the agent ("[Name]"),
 * record it in the Paperclip activity log, and guard every update with a
 * `test /rev` so concurrent edits are never overwritten.
 * See doc/plans/2026-11-14-ado-integration.md, "A8".
 */
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { AdoError, type AdoClient, type AdoWorkItem, type AdoWorkItemState, type JsonPatchOp } from "../ado/client.js";
import type { PluginDeps } from "../deps.js";
import type { LinkFeatures } from "../links/index.js";
import { TOOL_DECLARATIONS, TOOL_NAMES, type AdoToolName } from "./definitions.js";
import { attributedHtml, htmlToText, textToHtml } from "./html.js";
import { ROLE_POLICIES, pruneBindings, resolveRole, roleAllows, roleMayCreate, type AdoRole, type RoleBindings, type RoleBindingStore } from "./roles.js";
import { agentTag, hasOnlyAgentTag, withAgentTag } from "./tags.js";

/** Work item type states change rarely; cache them briefly per company and type. */
const STATE_CACHE_MS = 10 * 60 * 1000;
/** Runs whose task was looked up, so one run does not list issues on every call. */
const RUN_ISSUE_CACHE_SIZE = 200;
const MAX_TEXT_FIELD = 8000;

interface Caller {
  run: ToolRunContext;
  agentName: string;
  role: AdoRole;
  /** Set when a listed agent was given readonly instead of its listed role. */
  downgraded?: string;
}

const BINDINGS_KEY = "agent-role-bindings";

export interface AgentTools {
  /** Call with each company's saved settings, so a removed agentRoles entry drops its agent binding. */
  onConfigChanged(companyId: string, config: Record<string, unknown>): Promise<void>;
}

/** A failure the agent should see as-is. */
class ToolFailure extends Error {}

type Params = Record<string, unknown>;

export function registerAgentTools(deps: PluginDeps, links: LinkFeatures): AgentTools {
  const { ctx } = deps;
  const stateCache = new Map<string, { states: AdoWorkItemState[]; expires: number }>();
  const runIssues = new Map<string, string>();

  function bindingStore(companyId: string): RoleBindingStore {
    const key = { scopeKind: "company" as const, scopeId: companyId, stateKey: BINDINGS_KEY };
    return {
      async load() {
        const value = await ctx.state.get(key);
        return value && typeof value === "object" ? (value as RoleBindings) : {};
      },
      save: (bindings) => ctx.state.set(key, bindings),
    };
  }

  async function identify(run: ToolRunContext): Promise<Caller> {
    // The host checks that the run id belongs to this agent and company. It does
    // not check that the run is still active (see the plan doc, "A8").
    const agent = await ctx.agents.get(run.agentId, run.companyId).catch(() => null);
    const agentName = agent?.name?.trim() || `agent ${run.agentId}`;
    let agentRoles: unknown;
    try {
      agentRoles = (await ctx.config.get(run.companyId)).agentRoles;
    } catch {
      agentRoles = undefined;
    }
    const decision = await resolveRole(agentRoles, agent ? { id: agent.id, name: agent.name } : null, bindingStore(run.companyId));
    if (decision.downgraded) {
      ctx.logger.warn("ADO tools: agent treated as readonly", { agentId: run.agentId, agentName, reason: decision.downgraded });
    }
    return { run, agentName, role: decision.role, downgraded: decision.downgraded };
  }

  /**
   * The Paperclip task this run is working on. The tool context carries no
   * task, so find the agent's task whose execution run (preferred) or checkout
   * run is this run. The SDK's issue list cannot be sorted, so look at the
   * agent's in-progress tasks first and then at all of them. Only hits are
   * cached: a run can check out its task after its first tool call.
   */
  async function runIssueId(run: ToolRunContext): Promise<string | null> {
    const cached = runIssues.get(run.runId);
    if (cached) return cached;
    type Row = { id: string; executionRunId?: string | null; checkoutRunId?: string | null };
    let found: string | null = null;
    try {
      const base = { companyId: run.companyId, assigneeAgentId: run.agentId };
      const inProgress = (await ctx.issues.list({ ...base, status: "in_progress", limit: 50 })) as Row[];
      const byExecution = (rows: Row[]) => rows.find((i) => i.executionRunId === run.runId)?.id ?? null;
      const byCheckout = (rows: Row[]) => rows.find((i) => i.checkoutRunId === run.runId)?.id ?? null;
      found = byExecution(inProgress);
      if (!found) {
        const all = (await ctx.issues.list({ ...base, limit: 200 })) as Row[];
        found = byExecution(all) ?? byCheckout(inProgress) ?? byCheckout(all);
      }
    } catch (err) {
      ctx.logger.warn("Could not look up the task of an agent run", { runId: run.runId, error: errorText(err) });
      return null;
    }
    if (!found) return null;
    if (runIssues.size >= RUN_ISSUE_CACHE_SIZE) runIssues.delete(runIssues.keys().next().value!);
    runIssues.set(run.runId, found);
    return found;
  }

  async function resolveWorkItemId(run: ToolRunContext, given: unknown, param = "workItemId"): Promise<number> {
    if (given !== undefined && given !== null) return positiveInt(given, param);
    const issueId = await runIssueId(run);
    if (!issueId) {
      throw new ToolFailure(`No ${param} was given and this run is not working on a task, so there is no default work item. Pass ${param}.`);
    }
    const link = await links.findLinkByIssue(run.companyId, issueId);
    if (!link) throw new ToolFailure(`No ${param} was given and your current task is not linked to an ADO work item. Pass ${param}.`);
    return link.workItemId;
  }

  async function typeStates(companyId: string, ado: AdoClient, type: string): Promise<AdoWorkItemState[]> {
    const key = `${companyId}\u0000${type.toLowerCase()}`;
    const hit = stateCache.get(key);
    if (hit && hit.expires > deps.now()) return hit.states;
    const states = await ado.getWorkItemTypeStates(type);
    stateCache.set(key, { states, expires: deps.now() + STATE_CACHE_MS });
    return states;
  }

  /** Record a write in the Paperclip activity log; on the run's task when there is one. */
  async function audit(caller: Caller, action: string, workItemId: number, summary: string, extra: Record<string, unknown> = {}) {
    const { run } = caller;
    try {
      const issueId = await runIssueId(run);
      await ctx.activity.log({
        companyId: run.companyId,
        message: `[${caller.agentName}] ${summary}`,
        ...(issueId ? { entityType: "issue", entityId: issueId } : {}),
        metadata: {
          type: `plugin.ado.${action}`,
          action,
          agentId: run.agentId,
          agentName: caller.agentName,
          role: caller.role,
          runId: run.runId,
          workItemId,
          ...extra,
        },
      });
    } catch (err) {
      // The ADO write has happened; do not report it as failed.
      ctx.logger.error("Could not record an ADO write in the activity log", { action, workItemId, runId: run.runId, error: errorText(err) });
    }
  }

  /**
   * Tag the item with the commenting agent. Skipped when the tag is already right (no
   * extra revision). Best effort: the comment is already posted, so a conflict or error
   * here is retried once and then only logged.
   */
  async function tagAfterComment(caller: Caller, ado: AdoClient, id: number): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const item = await ado.getWorkItem(id);
        if (hasOnlyAgentTag(item.fields["System.Tags"], caller.agentName)) return;
        await ado.updateWorkItem(id, [
          { op: "test", path: "/rev", value: item.rev },
          { op: "add", path: "/fields/System.Tags", value: withAgentTag(item.fields["System.Tags"], caller.agentName) },
        ]);
        return;
      } catch (err) {
        if (attempt === 2) {
          deps.ctx.logger.warn("Could not set the agent tag after a comment", { workItemId: id, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  const handlers: Record<AdoToolName, (caller: Caller, params: Params, ado: AdoClient) => Promise<ToolResult>> = {
    async [TOOL_NAMES.getWorkItem](caller, params, ado) {
      const id = await resolveWorkItemId(caller.run, params.workItemId);
      const commentCount = params.commentCount === undefined ? 5 : boundedInt(params.commentCount, "commentCount", 0, 20);
      const item = await ado.getWorkItem(id);
      const comments = commentCount > 0 ? await ado.listComments(id, commentCount) : { comments: [], totalCount: 0 };
      const data = {
        ...describeWorkItem(item, ado.webUrl(id)),
        comments: comments.comments.map((c) => ({ id: c.id, author: c.createdBy, date: c.createdDate, text: clip(htmlToText(c.text)) })),
        totalComments: comments.totalCount,
      };
      return { content: JSON.stringify(data, null, 2), data };
    },

    async [TOOL_NAMES.addComment](caller, params, ado) {
      const text = requiredText(params.text, "text");
      const id = await resolveWorkItemId(caller.run, params.workItemId);
      const comment = await ado.addComment(id, attributedHtml(caller.agentName, text));
      // Comments go through their own API, so the agent tag needs a separate small update.
      await tagAfterComment(caller, ado, id);
      await audit(caller, "comment_added", id, `commented on ADO #${id}`, { commentId: comment.id });
      return { content: `Comment ${comment.id} added to work item #${id}.`, data: { workItemId: id, commentId: comment.id } };
    },

    async [TOOL_NAMES.setState](caller, params, ado) {
      const target = requiredText(params.state, "state").trim();
      const note = optionalText(params.comment, "comment");
      const id = await resolveWorkItemId(caller.run, params.workItemId);
      const item = await ado.getWorkItem(id);
      const type = String(item.fields["System.WorkItemType"] ?? "");
      const current = String(item.fields["System.State"] ?? "");
      const states = await typeStates(caller.run.companyId, ado, type);
      const match = states.find((s) => s.name.toLowerCase() === target.toLowerCase());
      if (!match) {
        throw new ToolFailure(`"${target}" is not a state of ${type}. Valid states: ${states.map((s) => s.name).join(", ")}.`);
      }
      if (match.name === current) {
        return { content: `Work item #${id} is already ${current}; nothing changed.`, data: { workItemId: id, state: current, changed: false } };
      }
      const history = `Changed state from ${current} to ${match.name}.` + (note ? `\n${note}` : "");
      const updated = await ado.updateWorkItem(id, [
        { op: "test", path: "/rev", value: item.rev },
        { op: "replace", path: "/fields/System.State", value: match.name },
        { op: "add", path: "/fields/System.History", value: attributedHtml(caller.agentName, history) },
        { op: "add", path: "/fields/System.Tags", value: withAgentTag(item.fields["System.Tags"], caller.agentName) },
      ]);
      await audit(caller, "state_changed", id, `moved ADO #${id} from ${current} to ${match.name}`, { from: current, to: match.name, rev: updated.rev });
      return {
        content: `Work item #${id} moved from ${current} to ${match.name}.`,
        data: { workItemId: id, from: current, state: match.name, rev: updated.rev, changed: true },
      };
    },

    async [TOOL_NAMES.linkPullRequest](caller, params, ado) {
      const repository = requiredText(params.repository, "repository").trim();
      const prId = positiveInt(params.pullRequestId, "pullRequestId");
      const id = await resolveWorkItemId(caller.run, params.workItemId);
      const repo = await withNotFound(ado.getRepository(repository), `Repository "${repository}" was not found in the ADO project.`);
      const pr = await withNotFound(ado.getPullRequest(repo.id, prId), `Pull request ${prId} was not found in repository ${repo.name}.`);
      const artifactUrl = `vstfs:///Git/PullRequestId/${repo.projectId}%2F${repo.id}%2F${prId}`;
      const item = await ado.getWorkItem(id);
      if ((item.relations ?? []).some((r) => r.url.toLowerCase() === artifactUrl.toLowerCase())) {
        return { content: `Pull request ${prId} is already linked to work item #${id}.`, data: { workItemId: id, pullRequestId: prId, changed: false } };
      }
      const updated = await ado.updateWorkItem(id, [
        { op: "test", path: "/rev", value: item.rev },
        { op: "add", path: "/relations/-", value: { rel: "ArtifactLink", url: artifactUrl, attributes: { name: "Pull Request" } } },
        {
          op: "add",
          path: "/fields/System.History",
          value: attributedHtml(caller.agentName, `Linked pull request ${prId} (${pr.title}) in ${repo.name}.`),
        },
        { op: "add", path: "/fields/System.Tags", value: withAgentTag(item.fields["System.Tags"], caller.agentName) },
      ]);
      await audit(caller, "pull_request_linked", id, `linked PR ${prId} in ${repo.name} to ADO #${id}`, {
        repositoryId: repo.id,
        repository: repo.name,
        pullRequestId: prId,
        rev: updated.rev,
      });
      return {
        content: `Pull request ${prId} (${pr.title}) in ${repo.name} linked to work item #${id}.`,
        data: { workItemId: id, pullRequestId: prId, repositoryId: repo.id, changed: true },
      };
    },

    async [TOOL_NAMES.createChildWorkItem](caller, params, ado) {
      const type = requiredText(params.type, "type").trim();
      const title = requiredText(params.title, "title").trim();
      const description = optionalText(params.description, "description");
      if (!roleMayCreate(caller.role, type)) {
        const allowed = ROLE_POLICIES[caller.role].createTypes;
        throw new ToolFailure(
          `Your ADO role (${caller.role}) may not create ${type} work items` +
            (Array.isArray(allowed) && allowed.length ? `; it may create: ${allowed.join(", ")}.` : "."),
        );
      }
      const parentId = await resolveWorkItemId(caller.run, params.parentId, "parentId");
      const parent = await withNotFound(ado.getWorkItem(parentId), `Parent work item #${parentId} was not found.`);
      const ops: JsonPatchOp[] = [
        { op: "add", path: "/fields/System.Title", value: title },
        ...(description ? [{ op: "add" as const, path: "/fields/System.Description", value: textToHtml(description) }] : []),
        ...inherit(parent, "System.AreaPath"),
        ...inherit(parent, "System.IterationPath"),
        { op: "add", path: "/fields/System.History", value: attributedHtml(caller.agentName, `Created as a child of #${parentId}.`) },
        { op: "add", path: "/fields/System.Tags", value: agentTag(caller.agentName) },
        { op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: ado.workItemApiUrl(parentId) } },
      ];
      const created = await ado.createWorkItem(type, ops);
      await audit(caller, "work_item_created", created.id, `created ${type} ADO #${created.id} under #${parentId}`, { parentId, type, title });
      return {
        content: `Created ${type} #${created.id} "${title}" under #${parentId}: ${ado.webUrl(created.id)}`,
        data: { workItemId: created.id, parentId, type, url: ado.webUrl(created.id) },
      };
    },
  };

  async function runTool(tool: AdoToolName, rawParams: unknown, run: ToolRunContext): Promise<ToolResult> {
    let caller: Caller | null = null;
    try {
      caller = await identify(run);
      if (!roleAllows(caller.role, tool)) {
        ctx.logger.info("ADO tool denied", { tool, agentId: run.agentId, role: caller.role, runId: run.runId });
        return {
          error:
            `Permission denied: ${caller.agentName} has the ADO role "${caller.role}", which allows only ` +
            `${ROLE_POLICIES[caller.role].tools.join(", ")}.` +
            (caller.downgraded
              ? ` You are treated as readonly because ${caller.downgraded}.`
              : ` Ask the board to change your role in the Azure DevOps plugin settings if you need ${tool}.`),
        };
      }
      const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Params;
      const ado = await deps.adoClient(run.companyId).catch((err) => {
        throw new ToolFailure(`Azure DevOps is not available: ${errorText(err)}`);
      });
      return await handlers[tool](caller, params, ado);
    } catch (err) {
      return { error: failureMessage(err) };
    }

    function failureMessage(err: unknown): string {
      if (err instanceof ToolFailure) return err.message;
      if (err instanceof AdoError) {
        if (err.status === 429) {
          return "ADO is throttling requests from the shared service account. Try again later (in a few minutes); do not retry straight away.";
        }
        if (err.status === 503) {
          return "ADO is unavailable right now, so nothing may have been written. Try later; for a comment or a new work item, read the work item first to check it did not go through.";
        }
        if (err.status === 409 || err.status === 412 || /TF26071|test operation/i.test(err.detail)) {
          return "The work item changed since it was read (someone else edited it), so nothing was written. Re-read it with ado_get_work_item, check your change still makes sense, then try again.";
        }
        ctx.logger.warn("ADO tool call failed", { tool, runId: run.runId, status: err.status, error: err.message });
        if (err.status === 401 || err.status === 403) {
          return "The ADO service account was refused (its token may have expired or lack permission). Tell the board; retrying will not help.";
        }
        if (err.status === 404) return `ADO could not find what was asked for: ${err.detail || "not found"}`;
        if (err.status === 400) return `ADO rejected the request: ${err.detail}`;
        return `ADO request failed with status ${err.status}. Try again later.`;
      }
      ctx.logger.error("ADO tool failed", { tool, runId: run.runId, agent: caller?.agentName, error: errorText(err) });
      return `The ${tool} tool failed: ${errorText(err)}`;
    }
  }

  for (const decl of TOOL_DECLARATIONS) {
    const name = decl.name as AdoToolName;
    ctx.tools.register(
      name,
      { displayName: decl.displayName, description: decl.description, parametersSchema: decl.parametersSchema },
      (params, run) => runTool(name, params, run),
    );
  }

  return {
    async onConfigChanged(companyId, config) {
      try {
        const store = bindingStore(companyId);
        const current = await store.load();
        const pruned = pruneBindings(config.agentRoles, current);
        if (Object.keys(pruned).length !== Object.keys(current).length) await store.save(pruned);
      } catch (err) {
        ctx.logger.warn("Could not update ADO agent role bindings", { companyId, error: errorText(err) });
      }
    },
  };
}

function inherit(parent: AdoWorkItem, field: string): JsonPatchOp[] {
  const value = parent.fields[field];
  return typeof value === "string" && value ? [{ op: "add", path: `/fields/${field}`, value }] : [];
}

async function withNotFound<T>(promise: Promise<T>, message: string): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof AdoError && err.status === 404) throw new ToolFailure(message);
    throw err;
  }
}

function idFromUrl(url: string): number | null {
  const m = url.match(/\/workItems\/(\d+)$/i);
  return m ? Number(m[1]) : null;
}

function displayName(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "displayName" in value) return String((value as { displayName: unknown }).displayName);
  return null;
}

function clip(text: string): string {
  return text.length > MAX_TEXT_FIELD ? `${text.slice(0, MAX_TEXT_FIELD)}… (truncated)` : text;
}

/** The parts of a work item an agent needs, with HTML fields flattened to text. */
export function describeWorkItem(item: AdoWorkItem, url: string) {
  const f = item.fields;
  const text = (field: string) => (typeof f[field] === "string" ? clip(htmlToText(f[field] as string)) : null);
  let parent: number | null = null;
  const children: number[] = [];
  const related: number[] = [];
  const pullRequests: Array<{ repositoryId: string; pullRequestId: number }> = [];
  let otherLinks = 0;
  for (const r of item.relations ?? []) {
    const linked = idFromUrl(r.url);
    const pr = r.rel === "ArtifactLink" ? decodeURIComponent(r.url).match(/^vstfs:\/\/\/Git\/PullRequestId\/[^/]+\/([^/]+)\/(\d+)$/i) : null;
    if (r.rel === "System.LinkTypes.Hierarchy-Reverse" && linked) parent = linked;
    else if (r.rel === "System.LinkTypes.Hierarchy-Forward" && linked) children.push(linked);
    else if (r.rel === "System.LinkTypes.Related" && linked) related.push(linked);
    else if (pr) pullRequests.push({ repositoryId: pr[1]!, pullRequestId: Number(pr[2]) });
    else otherLinks++;
  }
  return {
    id: item.id,
    rev: item.rev,
    url,
    type: f["System.WorkItemType"] ?? null,
    title: f["System.Title"] ?? null,
    state: f["System.State"] ?? null,
    reason: f["System.Reason"] ?? null,
    assignedTo: displayName(f["System.AssignedTo"]),
    areaPath: f["System.AreaPath"] ?? null,
    iterationPath: f["System.IterationPath"] ?? null,
    tags: f["System.Tags"] ?? null,
    priority: f["Microsoft.VSTS.Common.Priority"] ?? null,
    storyPoints: f["Microsoft.VSTS.Scheduling.StoryPoints"] ?? null,
    description: text("System.Description"),
    acceptanceCriteria: text("Microsoft.VSTS.Common.AcceptanceCriteria"),
    reproSteps: text("Microsoft.VSTS.TCM.ReproSteps"),
    parent,
    children,
    related,
    pullRequests,
    otherLinks,
  };
}

function positiveInt(value: unknown, name: string): number {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new ToolFailure(`${name} must be a positive whole number.`);
  return n;
}

function boundedInt(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolFailure(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ToolFailure(`${name} is required and must be non-empty text.`);
  return value;
}

function optionalText(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ToolFailure(`${name} must be text.`);
  return value.trim() ? value : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
