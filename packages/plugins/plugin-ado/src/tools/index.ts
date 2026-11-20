/**
 * A8: ADO tools for agents. All agent writes to ADO go through these tools,
 * which check the agent's role and the workflow rules (src/workflow/),
 * attribute the write to the agent ("[Name]"), record it in the Paperclip
 * activity log, and guard every update with a `test /rev` so concurrent edits
 * are never overwritten. See doc/plans/2026-11-14-ado-integration.md, "A8",
 * and doc/plans/2026-11-17-agent-workflow.md.
 */
import type { Agent, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  AdoError,
  PR_THREAD_STATUSES,
  type AdoClient,
  type AdoPullRequest,
  type AdoWorkItem,
  type AdoWorkItemState,
  type AdoWorkItemUpdate,
  type JsonPatchOp,
  type PrThreadStatus,
} from "../ado/client.js";
import type { PluginDeps } from "../deps.js";
import type { LinkFeatures } from "../links/index.js";
import { unassignableReason, type AssignDetails, type Assigner } from "../backlog/assign.js";
import { BacklogError } from "../backlog/errors.js";
import {
  APPROVED_STATE,
  BLOCKED_STATE,
  CHANGES_REQUESTED_STATE,
  COMPLETED_STATE,
  DEFECT_TYPE,
  FINAL_STATES,
  HANDOFF_TYPES,
  PASSED_STATE,
  QA_TEST_TYPE,
  READY_TO_MERGE_STATE,
  REVIEW_ROUND_LIMIT,
  REVIEW_TYPE,
  STORY_TYPES,
  assignmentNeedsParent,
  creationRule,
  decideAssignment,
  decideCreate,
  decideStateChange,
  rolesThatMayCreate,
  stateSetters,
  typeHasParent,
  workflowData,
  workflowText,
} from "../workflow/index.js";
import { TOOL_DECLARATIONS, TOOL_NAMES, type AdoToolName } from "./definitions.js";
import { attributedHtml, htmlToText, textToHtml } from "./html.js";
import { ROLE_POLICIES, pruneBindings, resolveRole, roleAllows, type AdoRole, type RoleBindings, type RoleBindingStore } from "./roles.js";
import { agentTag, cleanTag, editTags, hasOnlyAgentTag, isReservedTag, withAgentTag } from "./tags.js";
import { DEPENDS_ON_REL, predecessorIndexes } from "../workflow/dependencies.js";
import { repositoryOf, withRepositoryTag } from "../projects/index.js";
import { unifiedDiff } from "./diff.js";
import { BUILDER_TAG_PREFIX, FOR_TAG_PREFIX, withTag } from "../routing/index.js";
import { MAX_ANCESTORS, instructionsToCarry, keepInstructions, withInstructions } from "../workflow/instructions.js";

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

/** Wakeup context source of an assignment made by an agent tool. */
const AGENT_ASSIGN_SOURCE = "plugin.ado.agent-assign";

export function registerAgentTools(
  deps: PluginDeps,
  links: Pick<LinkFeatures, "findLinkByIssue" | "findTaskForWorkItem">,
  /** The Backlog view's assignment path; without it the assignment tools report that assigning is unavailable. */
  assigner: Assigner | null = null,
): AgentTools {
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

  /** The project of the task this run is working on, for a new linked task with no linked parent. */
  async function runTaskProjectId(run: ToolRunContext): Promise<string | null> {
    const issueId = await runIssueId(run);
    if (!issueId) return null;
    const issue = await ctx.issues.get(issueId, run.companyId).catch(() => null);
    return issue?.projectId ?? null;
  }

  /** An agent of the company by name (case-insensitive) or ID. Live agents win over terminated ones with the same name. */
  async function findAgent(companyId: string, nameOrId: string): Promise<Agent> {
    const wanted = nameOrId.trim().toLowerCase();
    const all = await ctx.agents.list({ companyId, limit: 500 });
    const byId = all.find((a) => a.id === nameOrId.trim());
    if (byId) return byId;
    const named = all.filter((a) => a.name.trim().toLowerCase() === wanted);
    const live = named.filter((a) => a.status !== "terminated");
    if (live.length > 1) throw new ToolFailure(`More than one agent is called "${nameOrId}". Ask the board which one is meant.`);
    const agent = live[0] ?? named[0];
    if (!agent) throw new ToolFailure(`No agent called "${nameOrId}" was found in this company.`);
    return agent;
  }

  /** Assign through the shared Backlog path, as the calling agent, under the workflow's assignment rules. */
  async function assignAs(caller: Caller, workItemId: number, target: Agent, note: string | null): Promise<AssignDetails> {
    if (!assigner) throw new ToolFailure("Assigning work items is not available in this plugin build.");
    const { run } = caller;
    try {
      return await assigner.assign({
        companyId: run.companyId,
        workItemId,
        agentId: target.id,
        actor: { actorAgentId: run.agentId },
        wakeSource: AGENT_ASSIGN_SOURCE,
        note: note ? { body: `[${caller.agentName}] ${note}`, authorAgentId: run.agentId } : null,
        fallbackProjectId: () => runTaskProjectId(run),
        async authorize(facts) {
          const current = facts.task ? { agentId: facts.task.assigneeAgentId ?? null, userId: facts.task.assigneeUserId ?? null } : null;
          const holder = current?.agentId === run.agentId ? await facts.holder() : null;
          const wi = await facts.item();
          const input = {
            role: caller.role,
            callerAgentId: run.agentId,
            targetAgentId: target.id,
            item: { type: wi.type, tags: wi.tags },
            current,
            heldByClaim: holder?.kind === "claimed",
          };
          const parentAssigneeAgentId = assignmentNeedsParent(input) ? ((await facts.parentTask())?.assigneeAgentId ?? null) : null;
          const decision = decideAssignment({ ...input, parentAssigneeAgentId });
          if (!decision.ok) throw new ToolFailure(`${decision.reason} Read the rules with ado_get_workflow.`);
          return { claimed: decision.rule === "claim" };
        },
      });
    } catch (err) {
      if (err instanceof BacklogError) throw new ToolFailure(err.message);
      throw err;
    }
  }

  function assignedText(workItemId: number, target: Agent, result: AssignDetails): string {
    const task = result.identifier ?? result.issueId;
    const what = result.created
      ? `created task ${task} for it, in To do`
      : result.changed
        ? `reassigned its task ${task}`
        : `its task ${task} was already assigned to ${target.name}; nothing changed`;
    return `ADO #${workItemId} assigned to ${target.name}: ${what}.` + (result.noteError ? ` The note could not be posted: ${result.noteError}` : "");
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
  async function audit(caller: Caller, action: string, workItemId: number | null, summary: string, extra: Record<string, unknown> = {}) {
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

  /** The work items directly under an item, with their type and state. */
  async function childrenOf(ado: AdoClient, item: AdoWorkItem): Promise<Array<{ id: number; type: string; state: string; rev: number; tags: unknown }>> {
    const out: Array<{ id: number; type: string; state: string; rev: number; tags: unknown }> = [];
    for (const r of item.relations ?? []) {
      if (r.rel !== "System.LinkTypes.Hierarchy-Forward") continue;
      const childId = idFromUrl(r.url);
      if (!childId) continue;
      const child = await ado.getWorkItem(childId);
      out.push({
        id: childId,
        type: String(child.fields["System.WorkItemType"] ?? ""),
        state: String(child.fields["System.State"] ?? ""),
        rev: child.rev,
        tags: child.fields["System.Tags"],
      });
    }
    return out;
  }

  /** Whether the caller holds the linked task of the item's ADO parent. */
  async function ownsParent(caller: Caller, item: AdoWorkItem): Promise<boolean> {
    const parentId = parentIdOf(item);
    if (!parentId) return false;
    const task = await links.findTaskForWorkItem(caller.run.companyId, parentId);
    return !!task?.assigneeAgentId && task.assigneeAgentId === caller.run.agentId;
  }

  /** The work items a new pull request links to: the ones given, or the current task's. */
  async function prWorkItemIds(caller: Caller, given: unknown): Promise<number[]> {
    if (given === undefined || given === null) return [await resolveWorkItemId(caller.run, undefined)];
    if (!Array.isArray(given) || !given.length) throw new ToolFailure("workItemIds must be a non-empty list of work item IDs.");
    return [...new Set(given.map((v, i) => positiveInt(v, `workItemIds[${i}]`)))];
  }

  /** The work item of the current task, if there is one, for the activity log. */
  async function runWorkItemId(run: ToolRunContext): Promise<number | null> {
    const issueId = await runIssueId(run);
    if (!issueId) return null;
    return (await links.findLinkByIssue(run.companyId, issueId))?.workItemId ?? null;
  }

  async function findPullRequest(ado: AdoClient, params: Params): Promise<AdoPullRequest> {
    const id = positiveInt(params.pullRequestId, "pullRequestId");
    const repoName = optionalText(params.repository, "repository")?.trim() ?? null;
    if (repoName) {
      const repo = await withNotFound(ado.getRepository(repoName), `Repository "${repoName}" was not found in the ADO project.`);
      const pr = await withNotFound(ado.getPullRequest(repo.id, id), `Pull request ${id} was not found in repository ${repo.name}.`);
      return { ...pr, repositoryName: pr.repositoryName || repo.name };
    }
    return withNotFound(ado.getPullRequest(null, id), `Pull request ${id} was not found in the ADO project.`);
  }

  const handlers: Record<AdoToolName, (caller: Caller, params: Params, ado: AdoClient) => Promise<ToolResult>> = {
    async [TOOL_NAMES.getWorkItem](caller, params, ado) {
      const id = await resolveWorkItemId(caller.run, params.workItemId);
      const commentCount = params.commentCount === undefined ? 5 : boundedInt(params.commentCount, "commentCount", 0, 20);
      const item = await ado.getWorkItem(id);
      const comments = commentCount > 0 ? await ado.listComments(id, commentCount) : { comments: [], totalCount: 0 };
      const data = {
        ...describeWorkItem(item, ado.webUrl(id)),
        comments: comments.comments.map((c) => ({ id: c.id, author: c.createdBy, date: c.createdDate, text: clip(c.format === "markdown" ? c.text : htmlToText(c.text)) })),
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
      const task = await links.findTaskForWorkItem(caller.run.companyId, id);
      const isAssignee = !!task?.assigneeAgentId && task.assigneeAgentId === caller.run.agentId;
      const isParentOwner = stateSetters(type, match.name, current).setBy.includes("owner-of-parent") ? await ownsParent(caller, item) : false;
      const decision = decideStateChange({ role: caller.role, isAssignee, isParentOwner, type, from: current, to: match.name });
      if (!decision.ok) throw new ToolFailure(`${decision.reason} Read the rules with ado_get_workflow.`);
      const to = match.name.toLowerCase();
      const isStory = STORY_TYPES.some((t) => t.toLowerCase() === type.toLowerCase());
      const isFinal = (state: string) => FINAL_STATES.some((f) => f.toLowerCase() === state.toLowerCase());
      const ofType = (children: Awaited<ReturnType<typeof childrenOf>>, t: string) =>
        children.filter((c) => c.type.toLowerCase() === t.toLowerCase() && c.state.toLowerCase() !== "removed");
      let toClose: Awaited<ReturnType<typeof childrenOf>> = [];
      if (isStory && to === READY_TO_MERGE_STATE.toLowerCase()) {
        // Josh's turn only once every reviewer has approved.
        const reviews = ofType(await childrenOf(ado, item), REVIEW_TYPE);
        const open = reviews.filter((r) => ![APPROVED_STATE, COMPLETED_STATE].some((s) => s.toLowerCase() === r.state.toLowerCase()));
        if (!reviews.length) {
          throw new ToolFailure(`Not changed: #${id} has no ${REVIEW_TYPE} under it. The planner creates them; ask on your task (paperclip_block) if one is missing.`);
        }
        if (open.length) {
          throw new ToolFailure(
            `Not changed: #${id} has ${REVIEW_TYPE}s that are not ${APPROVED_STATE} (${open.map((r) => `#${r.id} ${r.state}`).join(", ")}). ` +
              `Set ${READY_TO_MERGE_STATE} when every ${REVIEW_TYPE} under it is ${APPROVED_STATE}; you are woken when one changes.`,
          );
        }
      }
      if (isStory && to === COMPLETED_STATE.toLowerCase()) {
        const children = await childrenOf(ado, item);
        const tests = ofType(children, QA_TEST_TYPE);
        const failing = tests.filter((t) => ![PASSED_STATE, COMPLETED_STATE].some((s) => s.toLowerCase() === t.state.toLowerCase()));
        const defects = ofType(children, DEFECT_TYPE).filter((d) => !isFinal(d.state));
        if (failing.length || defects.length) {
          throw new ToolFailure(
            `Not changed: #${id} is not done testing (` +
              [...failing.map((t) => `${QA_TEST_TYPE} #${t.id} ${t.state}`), ...defects.map((d) => `${DEFECT_TYPE} #${d.id} ${d.state}`)].join(", ") +
              `). Set ${COMPLETED_STATE} when every ${QA_TEST_TYPE} is ${PASSED_STATE} and every ${DEFECT_TYPE} is ${COMPLETED_STATE}; you are woken when one changes.`,
          );
        }
        toClose = children.filter((c) => HANDOFF_TYPES.some((t) => t.toLowerCase() === c.type.toLowerCase()) && !isFinal(c.state));
      }
      if (type.toLowerCase() === REVIEW_TYPE.toLowerCase() && to === CHANGES_REQUESTED_STATE.toLowerCase()) {
        const rounds = countReviewRounds(await ado.listUpdates(id));
        if (rounds + 1 >= REVIEW_ROUND_LIMIT) {
          throw new ToolFailure(
            `Not changed: this would be round ${rounds + 1} of changes on ${REVIEW_TYPE} #${id} since it last approved, and the limit is ${REVIEW_ROUND_LIMIT - 1}. ` +
              `Set #${id} to ${BLOCKED_STATE} instead, with a comment for Josh summarizing what is still wrong and what was tried.`,
          );
        }
      }
      const history = `Changed state from ${current} to ${match.name}.` + (note ? `\n${note}` : "");
      const updated = await ado.updateWorkItem(id, [
        { op: "test", path: "/rev", value: item.rev },
        { op: "replace", path: "/fields/System.State", value: match.name },
        { op: "add", path: "/fields/System.History", value: attributedHtml(caller.agentName, history) },
        { op: "add", path: "/fields/System.Tags", value: withAgentTag(item.fields["System.Tags"], caller.agentName) },
      ]);
      await audit(caller, "state_changed", id, `moved ADO #${id} from ${current} to ${match.name}`, {
        from: current,
        to: match.name,
        rev: updated.rev,
        rule: decision.rule,
      });
      // The Reviews and QA Tests of a finished item close with it.
      const closed: number[] = [];
      for (const c of toClose) {
        await ado.updateWorkItem(c.id, [
          { op: "test", path: "/rev", value: c.rev },
          { op: "replace", path: "/fields/System.State", value: COMPLETED_STATE },
          { op: "add", path: "/fields/System.History", value: attributedHtml(caller.agentName, `Closed with #${id}, which is ${COMPLETED_STATE}.`) },
          { op: "add", path: "/fields/System.Tags", value: withAgentTag(c.tags, caller.agentName) },
        ]);
        await audit(caller, "state_changed", c.id, `closed ADO #${c.id} with #${id}`, { from: c.state, to: COMPLETED_STATE });
        closed.push(c.id);
      }
      return {
        content: `Work item #${id} moved from ${current} to ${match.name}.` + (closed.length ? ` Closed with it: ${closed.map((c) => `#${c}`).join(", ")}.` : ""),
        data: { workItemId: id, from: current, state: match.name, rev: updated.rev, changed: true, ...(closed.length ? { closed } : {}) },
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

    async [TOOL_NAMES.createWorkItem](caller, params, ado) {
      const requested = requiredText(params.type, "type").trim();
      const type = creationRule(requested)?.type ?? requested;
      const title = requiredText(params.title, "title").trim();
      const description = optionalText(params.description, "description");
      const acceptanceCriteria = optionalText(params.acceptanceCriteria, "acceptanceCriteria");
      const givenReproSteps = optionalText(params.reproSteps, "reproSteps");
      const givenRepository = optionalText(params.repository, "repository");
      const builderRole = optionalText(params.builderRole, "builderRole")?.trim() ?? null;
      const forName = optionalText(params.forAgent, "forAgent")?.trim() ?? null;
      const lowerType = type.trim().toLowerCase();
      if (builderRole && lowerType !== "user story" && lowerType !== "bug") throw new ToolFailure(`Nothing was created: builderRole is only for a User Story or Bug; a ${type} has none.`);
      if (forName && !["review", "qa test", "task"].includes(lowerType)) throw new ToolFailure(`Nothing was created: forAgent is only for a Review, QA Test or Task.`);
      const forAgent = forName ? await findAgent(caller.run.companyId, forName).catch(() => null) : null;
      if (forName && !forAgent) throw new ToolFailure(`Nothing was created: there is no agent called "${forName}".`);
      const assignTo = optionalText(params.assignTo, "assignTo")?.trim() ?? null;
      const dependsOn = idList(params.dependsOn, "dependsOn");
      const { role } = caller;
      // Refuse a type the role may not create before reading anything.
      if (!rolesThatMayCreate(type).includes(role)) throw new ToolFailure(denial(decideCreate({ role, type, parentType: null })));
      // Which fields the type has and requires, from ADO (TF401320 on Defects in smoke test #868: Repro Steps,
      // then Acceptance Criteria). If ADO cannot say, fall back to the Agile defaults below.
      const typeFields = await ado
        .getWorkItemTypeFields(type)
        .then((list) => new Map(list.map((f) => [f.referenceName.toLowerCase(), f])))
        .catch(() => null);
      const hasField = (ref: string, fallback: boolean) => (typeFields ? typeFields.has(ref.toLowerCase()) : fallback);
      const isRequired = (ref: string) => typeFields?.get(ref.toLowerCase())?.alwaysRequired === true;
      if (acceptanceCriteria && !hasField(ACCEPTANCE_CRITERIA_FIELD, typeHasAcceptanceCriteria(type))) {
        throw new ToolFailure(`Nothing was created: a ${type} has no acceptance criteria field; put the criteria in the description.`);
      }
      if (givenReproSteps && !hasField(REPRO_STEPS_FIELD, typeHasReproSteps(type))) {
        throw new ToolFailure(`Nothing was created: a ${type} has no repro steps field; put them in the description.`);
      }
      // Repro Steps fall back to the description.
      const reproSteps = hasField(REPRO_STEPS_FIELD, typeHasReproSteps(type)) ? (givenReproSteps ?? description) : null;
      const missing: string[] = [];
      if (isRequired("System.Description") && !description?.trim()) missing.push("`description`");
      if (isRequired(ACCEPTANCE_CRITERIA_FIELD) && !acceptanceCriteria?.trim()) {
        missing.push("`acceptanceCriteria` (for a Defect: what must be true once it is fixed, one per line)");
      }
      if ((isRequired(REPRO_STEPS_FIELD) || type.trim().toLowerCase() === "defect") && !reproSteps?.trim()) {
        missing.push("`reproSteps` (the steps to reproduce, with the expected and actual result; the description is used if you leave it out)");
      }
      const filled = new Set(["system.description", ACCEPTANCE_CRITERIA_FIELD.toLowerCase(), REPRO_STEPS_FIELD.toLowerCase()]);
      for (const f of typeFields?.values() ?? []) {
        const ref = f.referenceName.toLowerCase();
        if (f.alwaysRequired && !f.hasDefault && !ref.startsWith("system.") && !filled.has(ref)) {
          missing.push(`the field "${f.name}" (${f.referenceName}), which this tool cannot fill: ask Josh to make it optional or give it a default`);
        }
      }
      if (missing.length) throw new ToolFailure(`Nothing was created: a ${type} requires ${missing.join("; ")}.`);
      const givenParent = params.parentId !== undefined && params.parentId !== null;
      let parent: AdoWorkItem | null = null;
      let parentId: number | null = null;
      if (typeHasParent(type) || givenParent) {
        parentId = await resolveWorkItemId(caller.run, params.parentId, "parentId");
        parent = await withNotFound(ado.getWorkItem(parentId), `Parent work item #${parentId} was not found.`);
      }
      const parentType = parent ? String(parent.fields["System.WorkItemType"] ?? "") : null;
      const decision = decideCreate({ role, type, parentType });
      if (!decision.ok) throw new ToolFailure(denial(decision));
      const target = assignTo ? await findAgent(caller.run.companyId, assignTo) : null;
      if (target) {
        // Check the target and the assignment rules (a new item has no linked task) before anything is created.
        const problem = unassignableReason(target);
        if (problem) throw new ToolFailure(`Nothing was created: ${problem}.`);
        const input = { role, callerAgentId: caller.run.agentId, targetAgentId: target.id, item: { type, tags: null }, current: null };
        const parentTask = parentId && assignmentNeedsParent(input) ? await links.findTaskForWorkItem(caller.run.companyId, parentId) : null;
        const pre = decideAssignment({ ...input, parentAssigneeAgentId: parentTask?.assigneeAgentId ?? null });
        if (!pre.ok) throw new ToolFailure(`Nothing was created: ${denial(pre)}`);
      }
      // A12: the item's repository, given or its parent's; it decides its task's Paperclip project.
      const repository = givenRepository ? await checkedRepository(ado, givenRepository) : parent ? repositoryOf(parent.fields["System.Tags"]) : null;
      // Josh's instructions on the items above travel down to the new one (workflow/instructions.ts).
      const carried = parent ? instructionsToCarry(type, description, await ancestorsOf(ado, parent)) : [];
      const fullDescription = withInstructions(description, carried);
      // A11: what it waits for, as Predecessor links (checked to exist before anything is created).
      for (const d of dependsOn) await withNotFound(ado.getWorkItem(d), `Nothing was created: work item #${d} in dependsOn was not found.`);
      const ops: JsonPatchOp[] = [
        { op: "add", path: "/fields/System.Title", value: title },
        ...(fullDescription ? [{ op: "add" as const, path: "/fields/System.Description", value: textToHtml(fullDescription) }] : []),
        ...(acceptanceCriteria
          ? [{ op: "add" as const, path: `/fields/${ACCEPTANCE_CRITERIA_FIELD}`, value: textToHtml(acceptanceCriteria) }]
          : []),
        ...(reproSteps ? [{ op: "add" as const, path: `/fields/${REPRO_STEPS_FIELD}`, value: textToHtml(reproSteps) }] : []),
        ...(parent ? [...inherit(parent, "System.AreaPath"), ...inherit(parent, "System.IterationPath")] : []),
        { op: "add", path: "/fields/System.History", value: attributedHtml(caller.agentName, parentId ? `Created as a child of #${parentId}.` : "Created.") },
        { op: "add", path: "/fields/System.Tags", value: routingTags(repository ? withRepositoryTag(agentTag(caller.agentName), repository) : agentTag(caller.agentName), builderRole, forAgent?.name ?? null) },
        ...(parentId ? [{ op: "add" as const, path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: ado.workItemApiUrl(parentId) } }] : []),
        ...dependsOn.map((d) => ({ op: "add" as const, path: "/relations/-", value: { rel: DEPENDS_ON_REL, url: ado.workItemApiUrl(d) } })),
      ];
      const created = await ado.createWorkItem(type, ops);
      const where = parentId ? ` under #${parentId}` : "";
      await audit(caller, "work_item_created", created.id, `created ${type} ADO #${created.id}${where}`, { parentId, type, title, rule: decision.rule });
      const data: Record<string, unknown> = { workItemId: created.id, parentId, type, url: ado.webUrl(created.id), repository, ...(builderRole ? { builderRole } : {}), ...(forAgent ? { forAgent: forAgent.name } : {}), ...(dependsOn.length ? { dependsOn } : {}) };
      let content = `Created ${type} #${created.id} "${title}"${where}: ${ado.webUrl(created.id)}`;
      if (carried.length) {
        data.instructionsCopiedFrom = carried.map((c) => c.sourceId);
        content += `\nCopied Josh's instructions from ${carried.map((c) => `#${c.sourceId}`).join(", ")} into its description.`;
      }
      if (target) {
        // The item exists now: report a refused or failed assignment in the reply, not as an error, so it is not created twice.
        try {
          const result = await assignAs(caller, created.id, target, null);
          await audit(caller, "work_item_assigned", created.id, `assigned ADO #${created.id} to ${target.name}`, assignedMeta(target, result));
          data.assignment = { agentId: target.id, agentName: target.name, issueId: result.issueId, identifier: result.identifier, created: result.created };
          content += `\n${assignedText(created.id, target, result)}`;
        } catch (err) {
          const reason = err instanceof ToolFailure ? err.message : errorText(err);
          data.assignmentError = reason;
          content += `\nIt was not assigned to ${target.name}: ${reason}`;
        }
      }
      return { content, data };
    },

    async [TOOL_NAMES.assign](caller, params) {
      const agentName = requiredText(params.agent, "agent").trim();
      const note = optionalText(params.note, "note");
      const id = await resolveWorkItemId(caller.run, params.workItemId);
      const target = await findAgent(caller.run.companyId, agentName);
      const result = await assignAs(caller, id, target, note);
      await audit(caller, "work_item_assigned", id, `assigned ADO #${id} to ${target.name}`, assignedMeta(target, result));
      return {
        content: assignedText(id, target, result),
        data: {
          workItemId: id,
          agentId: target.id,
          agentName: target.name,
          issueId: result.issueId,
          identifier: result.identifier,
          created: result.created,
          changed: result.changed,
          ...(result.noteError ? { noteError: result.noteError } : {}),
        },
      };
    },

    async [TOOL_NAMES.createPullRequest](caller, params, ado) {
      const repoName = requiredText(params.repository, "repository").trim();
      const sourceBranch = branchParam(params.sourceBranch, "sourceBranch");
      const targetBranch = params.targetBranch === undefined || params.targetBranch === null ? "main" : branchParam(params.targetBranch, "targetBranch");
      if (sourceBranch === targetBranch) throw new ToolFailure("sourceBranch and targetBranch are the same branch; push your work to its own branch first.");
      const title = requiredText(params.title, "title").trim();
      const description = optionalText(params.description, "description");
      const workItemIds = await prWorkItemIds(caller, params.workItemIds);
      const labels = stringList(params.labels, "labels").map(cleanTag).filter(Boolean);
      const repo = await withNotFound(ado.getRepository(repoName), `Repository "${repoName}" was not found in the ADO project.`);
      const existing = await ado.findActivePullRequest(repo.id, sourceBranch, targetBranch);
      if (existing) {
        return {
          content:
            `An active pull request from ${sourceBranch} into ${targetBranch} already exists: ${existing.pullRequestId} "${existing.title}" ` +
            `(${ado.pullRequestWebUrl(repo.name, existing.pullRequestId)}). Push more commits to the branch to update it; link it to other work items with ado_create_pr_link.`,
          data: prData(ado, repo.name, existing, false),
        };
      }
      const signed = `${description ? `${description.trim()}\n\n` : ""}_Opened by [${caller.agentName}]._`;
      const pr = await withNotFound(
        ado.createPullRequest(repo.id, { sourceBranch, targetBranch, title, description: signed, workItemIds, ...(labels.length ? { labels } : {}) }),
        `ADO could not open the pull request: branch ${sourceBranch} or ${targetBranch} was not found in ${repo.name}. Push the branch first.`,
      );
      await audit(caller, "pull_request_created", workItemIds[0] ?? null, `opened PR ${pr.pullRequestId} in ${repo.name} (${sourceBranch} into ${targetBranch})`, {
        repositoryId: repo.id,
        repository: repo.name,
        pullRequestId: pr.pullRequestId,
        workItemIds,
      });
      return {
        content:
          `Opened pull request ${pr.pullRequestId} "${pr.title}" from ${sourceBranch} into ${targetBranch} in ${repo.name}, ` +
          `linked to ${workItemIds.map((id) => `#${id}`).join(", ")}: ${ado.pullRequestWebUrl(repo.name, pr.pullRequestId)}`,
        data: { ...prData(ado, repo.name, pr, true), workItemIds },
      };
    },

    async [TOOL_NAMES.getPullRequestThreads](_caller, params, ado) {
      const pr = await findPullRequest(ado, params);
      const includeSystem = params.includeSystem === true;
      const threads = (await ado.listPullRequestThreads(pr.repositoryId, pr.pullRequestId))
        .map((t) => ({ ...t, comments: includeSystem ? t.comments : t.comments.filter((c) => c.commentType !== "system") }))
        .filter((t) => t.comments.length > 0);
      const repoLabel = pr.repositoryName || pr.repositoryId;
      const lines = [
        `Pull request ${pr.pullRequestId} "${pr.title}" (${pr.status}) in ${repoLabel}, ${pr.sourceBranch ?? "?"} into ${pr.targetBranch ?? "?"}: ` +
          ado.pullRequestWebUrl(repoLabel, pr.pullRequestId),
        "",
        threads.length ? `${threads.length} thread${threads.length === 1 ? "" : "s"}:` : "No comment threads.",
      ];
      for (const t of threads) {
        const where = t.filePath ? ` on ${t.filePath}${t.line ? ` line ${t.line}` : ""}` : "";
        lines.push("", `Thread ${t.id} (${t.status})${where}:`);
        for (const c of t.comments) lines.push(`- ${c.author || "Someone"}: ${c.content}`);
      }
      return {
        content: lines.join("\n"),
        data: { ...prData(ado, repoLabel, pr, false), threads },
      };
    },

    async [TOOL_NAMES.postPullRequestComment](caller, params, ado) {
      const text = requiredText(params.text, "text").trim();
      const threadId = params.threadId === undefined || params.threadId === null ? null : positiveInt(params.threadId, "threadId");
      const status = threadStatusParam(params.status);
      const filePath = optionalText(params.filePath, "filePath")?.trim() ?? null;
      const line = params.line === undefined || params.line === null ? null : positiveInt(params.line, "line");
      if (threadId && (filePath || line)) throw new ToolFailure("filePath and line are only for a new thread; leave them out when replying with threadId.");
      if (line && !filePath) throw new ToolFailure("line needs filePath.");
      const pr = await findPullRequest(ado, params);
      if (pr.status && pr.status !== "active") {
        throw new ToolFailure(`Pull request ${pr.pullRequestId} is ${pr.status}, so nothing was posted. Comment on the work item instead.`);
      }
      const content = signPrText(caller.agentName, text);
      const workItemId = await runWorkItemId(caller.run);
      const repoLabel = pr.repositoryName || pr.repositoryId;
      if (threadId) {
        const reply = await withNotFound(
          ado.addPullRequestThreadComment(pr.repositoryId, pr.pullRequestId, threadId, content),
          `Thread ${threadId} was not found on pull request ${pr.pullRequestId}. Read the threads with ado_get_pr_threads.`,
        );
        if (status) await ado.updatePullRequestThreadStatus(pr.repositoryId, pr.pullRequestId, threadId, status);
        await audit(caller, "pull_request_replied", workItemId, `replied on thread ${threadId} of PR ${pr.pullRequestId}`, {
          repositoryId: pr.repositoryId,
          pullRequestId: pr.pullRequestId,
          threadId,
          ...(status ? { status } : {}),
        });
        return {
          content: `Replied on thread ${threadId} of pull request ${pr.pullRequestId}${status ? ` and set it ${status}` : ""}.`,
          data: { pullRequestId: pr.pullRequestId, repositoryId: pr.repositoryId, threadId, commentId: reply.commentId, ...(status ? { status } : {}) },
        };
      }
      const created = await ado.createPullRequestThread(pr.repositoryId, pr.pullRequestId, {
        content,
        status: status ?? "active",
        filePath,
        line,
      });
      await audit(caller, "pull_request_thread_created", workItemId, `started thread ${created.threadId} on PR ${pr.pullRequestId}`, {
        repositoryId: pr.repositoryId,
        pullRequestId: pr.pullRequestId,
        threadId: created.threadId,
        status: status ?? "active",
        ...(filePath ? { filePath, line } : {}),
      });
      return {
        content:
          `Started thread ${created.threadId} (${status ?? "active"}) on pull request ${pr.pullRequestId}` +
          `${filePath ? ` on ${filePath}${line ? ` line ${line}` : ""}` : ""}: ${ado.pullRequestWebUrl(repoLabel, pr.pullRequestId)}`,
        data: { pullRequestId: pr.pullRequestId, repositoryId: pr.repositoryId, threadId: created.threadId, commentId: created.commentId, status: status ?? "active" },
      };
    },

    async [TOOL_NAMES.updateWorkItem](caller, params, ado) {
      const title = optionalText(params.title, "title")?.trim() || null;
      const description = optionalText(params.description, "description")?.trim() || null;
      const acceptanceCriteria = optionalText(params.acceptanceCriteria, "acceptanceCriteria")?.trim() || null;
      const reproSteps = optionalText(params.reproSteps, "reproSteps")?.trim() || null;
      const addTags = stringList(params.addTags, "addTags").map(cleanTag).filter(Boolean);
      const removeTags = stringList(params.removeTags, "removeTags").map(cleanTag).filter(Boolean);
      const builderRole = optionalText(params.builderRole, "builderRole")?.trim() || null;
      const forName = optionalText(params.forAgent, "forAgent")?.trim() || null;
      const addDeps = idList(params.dependsOn, "dependsOn");
      const removeDeps = idList(params.removeDependsOn, "removeDependsOn");
      const note = optionalText(params.comment, "comment")?.trim() || null;
      const reserved = [...addTags, ...removeTags].filter(isReservedTag);
      if (reserved.length) {
        throw new ToolFailure(
          `Nothing was changed: ${reserved.join(", ")} ${reserved.length === 1 ? "is a tag" : "are tags"} the plugin manages. ` +
            "Use builderRole or forAgent here, or `repository` on ado_update_technical_notes; agent: tags are written for you.",
        );
      }
      if (![title, description, acceptanceCriteria, reproSteps, builderRole, forName].some(Boolean) && !addTags.length && !removeTags.length && !addDeps.length && !removeDeps.length) {
        throw new ToolFailure("Nothing was changed: give at least one thing to change.");
      }
      const id = await resolveWorkItemId(caller.run, params.workItemId);
      const item = await withNotFound(ado.getWorkItem(id), `Work item #${id} was not found in ADO.`);
      const type = String(item.fields["System.WorkItemType"] ?? "");
      const state = String(item.fields["System.State"] ?? "");
      if (!rolesThatMayCreate(type).includes(caller.role)) {
        throw new ToolFailure(`Nothing was changed: a ${caller.role} may not change a ${type}; the roles that create it may (ado_get_workflow).`);
      }
      if (FINAL_STATES.some((f) => f.toLowerCase() === state.toLowerCase())) throw new ToolFailure(`Nothing was changed: #${id} is ${state}.`);
      const lowerType = type.trim().toLowerCase();
      const task = builderRole || forName ? await links.findTaskForWorkItem(caller.run.companyId, id) : null;
      if (builderRole) {
        if (lowerType !== "user story" && lowerType !== "bug") throw new ToolFailure(`Nothing was changed: builderRole is only for a User Story or Bug; a ${type} has none.`);
        if (task?.assigneeAgentId) throw new ToolFailure(`Nothing was changed: #${id} is already assigned; its builder role no longer decides who gets it.`);
      }
      const forAgent = forName ? await findAgent(caller.run.companyId, forName).catch(() => null) : null;
      if (forName) {
        if (!["review", "qa test", "task"].includes(lowerType)) throw new ToolFailure("Nothing was changed: forAgent is only for a Review, QA Test or Task.");
        if (!forAgent) throw new ToolFailure(`Nothing was changed: there is no agent called "${forName}".`);
        if (task?.assigneeAgentId) throw new ToolFailure(`Nothing was changed: #${id} is already assigned; reassign it with ado_update_assignment instead.`);
      }
      const typeFields = acceptanceCriteria || reproSteps
        ? await ado.getWorkItemTypeFields(type).then((list) => new Set(list.map((f) => f.referenceName.toLowerCase()))).catch(() => null)
        : null;
      const hasField = (ref: string, fallback: boolean) => (typeFields ? typeFields.has(ref.toLowerCase()) : fallback);
      if (acceptanceCriteria && !hasField(ACCEPTANCE_CRITERIA_FIELD, typeHasAcceptanceCriteria(type))) {
        throw new ToolFailure(`Nothing was changed: a ${type} has no acceptance criteria field; put the criteria in the description.`);
      }
      if (reproSteps && !hasField(REPRO_STEPS_FIELD, typeHasReproSteps(type))) {
        throw new ToolFailure(`Nothing was changed: a ${type} has no repro steps field; put them in the description.`);
      }
      // Dependencies: added ones must exist and not be the item itself; existing links are not added twice.
      const existing = predecessorIndexes(item);
      const toAdd = addDeps.filter((d) => !existing.has(d));
      for (const d of toAdd) {
        if (d === id) throw new ToolFailure(`Nothing was changed: #${id} cannot depend on itself.`);
        await withNotFound(ado.getWorkItem(d), `Nothing was changed: work item #${d} in dependsOn was not found.`);
      }
      const toRemove = removeDeps.filter((d) => existing.has(d));

      const changed: string[] = [];
      const ops: JsonPatchOp[] = [{ op: "test", path: "/rev", value: item.rev }];
      if (title && title !== String(item.fields["System.Title"] ?? "")) {
        ops.push({ op: "add", path: "/fields/System.Title", value: title });
        changed.push("title");
      }
      let instructionsKept = false;
      if (description) {
        const full = keepInstructions(description, item.fields["System.Description"]);
        instructionsKept = full !== description;
        ops.push({ op: "add", path: "/fields/System.Description", value: textToHtml(full) });
        changed.push("description");
      }
      if (acceptanceCriteria) {
        ops.push({ op: "add", path: `/fields/${ACCEPTANCE_CRITERIA_FIELD}`, value: textToHtml(acceptanceCriteria) });
        changed.push("acceptance criteria");
      }
      if (reproSteps) {
        ops.push({ op: "add", path: `/fields/${REPRO_STEPS_FIELD}`, value: textToHtml(reproSteps) });
        changed.push("repro steps");
      }
      const tags = withAgentTag(routingTags(editTags(item.fields["System.Tags"], addTags, removeTags), builderRole, forAgent?.name ?? null), caller.agentName);
      const tagNotes = [
        ...addTags.map((t) => `+${t}`),
        ...removeTags.map((t) => `-${t}`),
        ...(builderRole ? [`builder:${builderRole}`] : []),
        ...(forAgent ? [`for:${forAgent.name}`] : []),
      ];
      if (tagNotes.length) changed.push(`tags (${tagNotes.join(", ")})`);
      ops.push({ op: "add", path: "/fields/System.Tags", value: tags });
      // Remove links from the highest index down, so the indexes stay right.
      for (const idx of toRemove.map((d) => existing.get(d)!).sort((a, b) => b - a)) ops.push({ op: "remove", path: `/relations/${idx}` });
      for (const d of toAdd) ops.push({ op: "add", path: "/relations/-", value: { rel: DEPENDS_ON_REL, url: ado.workItemApiUrl(d) } });
      if (toAdd.length) changed.push(`depends on ${toAdd.map((d) => `#${d}`).join(", ")}`);
      if (toRemove.length) changed.push(`no longer depends on ${toRemove.map((d) => `#${d}`).join(", ")}`);
      if (!changed.length) {
        return { content: `Nothing changed on #${id}: it already has what you gave.`, data: { workItemId: id, changed: false } };
      }
      const history = `Changed ${changed.join("; ")}.${note ? ` ${note}` : ""}`;
      ops.push({ op: "add", path: "/fields/System.History", value: attributedHtml(caller.agentName, history) });
      const updated = await ado.updateWorkItem(id, ops);
      await audit(caller, "work_item_updated", id, `updated ADO #${id}: ${changed.join("; ")}`, { rev: updated.rev, changed });
      const kept = instructionsKept ? " Josh's instructions were kept at the end of the description." : "";
      return {
        content: `Updated ${type} #${id}: ${changed.join("; ")}.${kept}`,
        data: { workItemId: id, rev: updated.rev, changed, ...(toAdd.length ? { addedDependencies: toAdd } : {}), ...(toRemove.length ? { removedDependencies: toRemove } : {}) },
      };
    },

    async [TOOL_NAMES.setTechnicalNotes](caller, params, ado) {
      const notes = requiredText(params.notes, "notes").trim();
      const givenRepository = optionalText(params.repository, "repository");
      const id = await resolveWorkItemId(caller.run, params.workItemId);
      const item = await withNotFound(ado.getWorkItem(id), `Work item #${id} was not found in ADO.`);
      const type = String(item.fields["System.WorkItemType"] ?? "");
      if (!TECHNICAL_NOTES_TYPES.has(type.trim().toLowerCase())) {
        throw new ToolFailure(`Nothing was changed: a ${type} has no technical notes; they go on an Epic, Feature, User Story, Bug or Task.`);
      }
      const state = String(item.fields["System.State"] ?? "");
      if (FINAL_STATES.some((f) => f.toLowerCase() === state.toLowerCase())) throw new ToolFailure(`Nothing was changed: #${id} is ${state}.`);
      const repository = givenRepository ? await checkedRepository(ado, givenRepository) : null;
      const tags = withAgentTag(item.fields["System.Tags"], caller.agentName);
      const updated = await ado.updateWorkItem(id, [
        { op: "test", path: "/rev", value: item.rev },
        { op: "add", path: "/fields/Custom.TechnicalNotes", value: textToHtml(notes) },
        {
          op: "add",
          path: "/fields/System.History",
          value: attributedHtml(caller.agentName, repository ? `Updated the technical notes (repository ${repository}).` : "Updated the technical notes."),
        },
        { op: "add", path: "/fields/System.Tags", value: repository ? withRepositoryTag(tags, repository) : tags },
      ]);
      await audit(caller, "technical_notes_updated", id, `updated the technical notes of ADO #${id}`, { rev: updated.rev, repository });
      const where = repository ? ` Repository set to ${repository}: tasks created for it from now on go in that repository's Paperclip project.` : "";
      return {
        content: `Technical notes of ${type} #${id} updated.${where}`,
        data: { workItemId: id, rev: updated.rev, changed: true, repository: repository ?? repositoryOf(item.fields["System.Tags"]) },
      };
    },

    async [TOOL_NAMES.getFile](_caller, params, ado) {
      const repoName = requiredText(params.repository, "repository").trim();
      const path = requiredText(params.path, "path").trim();
      const commit = optionalText(params.commit, "commit")?.trim() ?? null;
      const branch = (optionalText(params.branch, "branch")?.trim() ?? "main").replace(/^refs\/heads\//, "");
      const startLine = params.startLine === undefined || params.startLine === null ? 1 : positiveInt(params.startLine, "startLine");
      const repo = await withNotFound(ado.getRepository(repoName), `Repository "${repoName}" was not found in the ADO project.`);
      const at = commit ? `commit ${commit.slice(0, 8)}` : `branch ${branch}`;
      const item = await withNotFound(
        ado.getRepositoryItem(repo.id, path, commit ?? branch, commit ? "commit" : "branch"),
        `${path} was not found in ${repo.name} at ${at}.`,
      );
      if (item.kind === "folder") {
        const lines = item.entries.map((e) => `${e.path}${e.isFolder ? "/" : ""}`);
        return {
          content: `${repo.name} ${path} at ${at} is a folder with ${lines.length} entr${lines.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}`,
          data: { repository: repo.name, path, at, folder: true, entries: item.entries },
        };
      }
      if (item.content.includes("\u0000")) throw new ToolFailure(`${path} in ${repo.name} is a binary file; only text files can be read.`);
      const all = item.content.replace(/\r\n/g, "\n").split("\n");
      if (all.length > 1 && all[all.length - 1] === "") all.pop();
      const from = Math.min(startLine, Math.max(all.length, 1));
      const slice = all.slice(from - 1, from - 1 + FILE_LINES);
      const last = from - 1 + slice.length;
      const more = last < all.length ? `\n\n(${all.length - last} more lines: call again with startLine ${last + 1}.)` : "";
      const numbered = slice.map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join("\n");
      return {
        content: `${repo.name} ${path} at ${at}${item.commitId ? ` (commit ${item.commitId.slice(0, 8)})` : ""}, lines ${from}-${last} of ${all.length}:\n${numbered}${more}`,
        data: { repository: repo.name, path, at, commitId: item.commitId, totalLines: all.length, startLine: from, endLine: last },
      };
    },

    async [TOOL_NAMES.getPullRequestChanges](_caller, params, ado) {
      const pr = await findPullRequest(ado, params);
      const filePath = optionalText(params.filePath, "filePath")?.trim() ?? null;
      const repoLabel = pr.repositoryName || pr.repositoryId;
      const changes = await ado.getPullRequestChanges(pr.repositoryId, pr.pullRequestId);
      const head = `Pull request ${pr.pullRequestId} "${pr.title}" (${pr.status}) in ${repoLabel}, ${pr.sourceBranch ?? "?"} into ${pr.targetBranch ?? "?"}`;
      if (!filePath) {
        const lines = changes.changes.map((c) => `- ${c.changeType}: ${c.path}${c.originalPath ? ` (from ${c.originalPath})` : ""}`);
        return {
          content: `${head}, ${lines.length} file${lines.length === 1 ? "" : "s"} changed:\n${lines.join("\n") || "(none)"}`,
          data: { pullRequestId: pr.pullRequestId, repository: repoLabel, ...changes },
        };
      }
      const wanted = ("/" + filePath.replace(/^\/+/, "")).toLowerCase();
      const change = changes.changes.find((c) => c.path.toLowerCase() === wanted);
      if (!change) throw new ToolFailure(`${filePath} is not among the files pull request ${pr.pullRequestId} changes; call without filePath for the list.`);
      if (!changes.sourceCommit || !changes.targetCommit) throw new ToolFailure(`ADO did not say which commits pull request ${pr.pullRequestId} compares.`);
      const read = async (path: string, commit: string) => {
        try {
          const item = await ado.getRepositoryItem(pr.repositoryId, path, commit, "commit");
          return item.kind === "file" ? item.content : "";
        } catch (err) {
          if (err instanceof AdoError && err.status === 404) return "";
          throw err;
        }
      };
      const before = change.changeType.includes("add") ? "" : await read(change.originalPath ?? change.path, changes.targetCommit);
      const after = change.changeType.includes("delete") ? "" : await read(change.path, changes.sourceCommit);
      const diff = unifiedDiff(before, after, change.path);
      const content =
        diff === null
          ? `${head}: ${change.path} (${change.changeType}) is too long to diff here (${before.split("\n").length} lines before, ${after.split("\n").length} after). Read it with ado_get_file at branch ${pr.sourceBranch ?? "?"}.`
          : `${head}: ${change.path} (${change.changeType})\n${diff || "(no text change)"}`;
      return { content, data: { pullRequestId: pr.pullRequestId, repository: repoLabel, path: change.path, changeType: change.changeType, diffed: diff !== null } };
    },

    async [TOOL_NAMES.searchWorkItems](_caller, params, ado) {
      const text = requiredText(params.text, "text").trim();
      const type = optionalText(params.type, "type")?.trim() ?? null;
      const state = optionalText(params.state, "state")?.trim() ?? null;
      const top = params.top === undefined ? 20 : boundedInt(params.top, "top", 1, 50);
      const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
      const query =
        `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Title] CONTAINS ${q(text)}` +
        (type ? ` AND [System.WorkItemType] = ${q(type)}` : "") +
        (state ? ` AND [System.State] = ${q(state)}` : "") +
        ` ORDER BY [System.ChangedDate] DESC`;
      const ids = await ado.queryWorkItemIds(query, top);
      const items = ids.length ? await ado.getWorkItemSummaries(ids) : [];
      const byId = new Map(items.map((i) => [i.id, i]));
      const found = ids.map((id) => byId.get(id)).filter((i): i is NonNullable<typeof i> => !!i);
      const lines = found.map((i) => `- #${i.id} ${i.type} (${i.state}): ${i.title}${i.parentId ? `, under #${i.parentId}` : ""}`);
      return {
        content: found.length ? `${found.length} work item${found.length === 1 ? "" : "s"} with "${text}" in the title:\n${lines.join("\n")}` : `No work item has "${text}" in its title.`,
        data: { items: found.map((i) => ({ id: i.id, type: i.type, state: i.state, title: i.title, parentId: i.parentId, url: i.webUrl })) },
      };
    },

    async [TOOL_NAMES.getWorkflow](caller) {
      const tools = Object.fromEntries(Object.entries(ROLE_POLICIES).map(([role, p]) => [role, [...p.tools]]));
      const data = { you: { agent: caller.agentName, role: caller.role }, ...workflowData(), tools };
      const content =
        `You are ${caller.agentName}, ADO role ${caller.role}.\n\n${workflowText()}\n\nTools by role:\n` +
        Object.entries(tools)
          .map(([role, list]) => `- ${role}: ${list.join(", ")}`)
          .join("\n");
      return { content, data };
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
      // The rules and assignments need no ADO connection (assigning reads the item itself when it must).
      if (tool === TOOL_NAMES.getWorkflow) return await handlers[tool](caller, params, null as never);
      const ado = await deps.adoClient(run.companyId).catch((err) => {
        throw new ToolFailure(`Azure DevOps is not available: ${errorText(err)}`);
      });
      return await handlers[tool](caller, params, ado);
    } catch (err) {
      return { error: failureMessage(err) };
    }

    function failureMessage(err: unknown): string {
      if (err instanceof ToolFailure || err instanceof BacklogError) return err.message;
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

function denial(decision: { ok: boolean; reason?: string }): string {
  return `${decision.reason ?? "Not allowed by the workflow."} Read the rules with ado_get_workflow.`;
}

function assignedMeta(target: Agent, result: AssignDetails): Record<string, unknown> {
  return {
    targetAgentId: target.id,
    targetAgentName: target.name,
    issueId: result.issueId,
    created: result.created,
    changed: result.changed,
    previousAgentId: result.previousAgentId,
    ...(result.created ? { parentIssueId: result.parentIssueId, projectId: result.projectId } : {}),
  };
}

/** Types that have Custom.TechnicalNotes in the Chimera process. */
const TECHNICAL_NOTES_TYPES = new Set(["epic", "feature", "user story", "bug", "task"]);

/** A6: the builder:<role> and for:<agent> tags the router assigns by. */
function routingTags(tags: string, builderRole: string | null, forAgent: string | null): string {
  let out = tags;
  if (builderRole) out = withTag(out, BUILDER_TAG_PREFIX, builderRole);
  if (forAgent) out = withTag(out, FOR_TAG_PREFIX, forAgent);
  return out;
}

/** Lines ado_get_file returns at a time. */
const FILE_LINES = 2000;

/** The repository's name as ADO has it, or a refusal naming the ones that exist. */
async function checkedRepository(ado: AdoClient, name: string): Promise<string> {
  try {
    return (await ado.getRepository(name.trim())).name;
  } catch (err) {
    if (err instanceof AdoError && err.status === 404) {
      throw new ToolFailure(`Nothing was changed: there is no repository "${name.trim()}" in this ADO project.`);
    }
    throw err;
  }
}

/** The parent and the items above it, nearest first (at most MAX_ANCESTORS; a missing one ends the walk). */
async function ancestorsOf(ado: AdoClient, parent: AdoWorkItem): Promise<AdoWorkItem[]> {
  const out = [parent];
  const seen = new Set([parent.id]);
  let next = Number(parent.fields["System.Parent"] ?? 0);
  while (next > 0 && out.length < MAX_ANCESTORS && !seen.has(next)) {
    seen.add(next);
    const item = await ado.getWorkItem(next).catch(() => null);
    if (!item) break;
    out.push(item);
    next = Number(item.fields["System.Parent"] ?? 0);
  }
  return out;
}

const ACCEPTANCE_CRITERIA_FIELD = "Microsoft.VSTS.Common.AcceptanceCriteria";
const REPRO_STEPS_FIELD = "Microsoft.VSTS.TCM.ReproSteps";

/** Fallbacks when ADO cannot list a type's fields: the types that have Microsoft.VSTS.TCM.ReproSteps. */
const REPRO_STEPS_TYPES = new Set(["defect", "bug"]);

function typeHasReproSteps(type: string): boolean {
  return REPRO_STEPS_TYPES.has(type.trim().toLowerCase());
}

/** Types of the Agile process that have Microsoft.VSTS.Common.AcceptanceCriteria. */
const ACCEPTANCE_CRITERIA_TYPES = new Set(["epic", "feature", "user story"]);

function typeHasAcceptanceCriteria(type: string): boolean {
  return ACCEPTANCE_CRITERIA_TYPES.has(type.trim().toLowerCase());
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

/**
 * Rounds of changes a Review has asked for since it last approved: its moves
 * to Changes Requested after its latest move to Approved. A Defect fix after
 * an approval starts the count again.
 */
export function countReviewRounds(updates: AdoWorkItemUpdate[]): number {
  let rounds = 0;
  for (const u of updates) {
    const state = u.fields["System.State"];
    if (!state || typeof state.newValue !== "string") continue;
    const to = state.newValue.toLowerCase();
    if (to === CHANGES_REQUESTED_STATE.toLowerCase()) rounds++;
    else if (to === APPROVED_STATE.toLowerCase()) rounds = 0;
  }
  return rounds;
}

/** The ADO parent of an item, from System.Parent or its parent link. */
export function parentIdOf(item: AdoWorkItem): number | null {
  const field = Number(item.fields["System.Parent"]);
  if (Number.isInteger(field) && field > 0) return field;
  const rel = (item.relations ?? []).find((r) => r.rel === "System.LinkTypes.Hierarchy-Reverse");
  return rel ? idFromUrl(rel.url) : null;
}

/** A work item id from its API URL (a relation url). */
export function idFromUrl(url: string): number | null {
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
    technicalNotes: text("Custom.TechnicalNotes"),
    reproSteps: text("Microsoft.VSTS.TCM.ReproSteps"),
    parent,
    children,
    related,
    pullRequests,
    otherLinks,
  };
}

function prData(ado: AdoClient, repository: string, pr: AdoPullRequest, created: boolean) {
  return {
    pullRequestId: pr.pullRequestId,
    repositoryId: pr.repositoryId,
    repository,
    title: pr.title,
    status: pr.status,
    sourceBranch: pr.sourceBranch,
    targetBranch: pr.targetBranch,
    url: ado.pullRequestWebUrl(repository, pr.pullRequestId),
    created,
  };
}

/** A branch name, without refs/heads/. */
function branchParam(value: unknown, name: string): string {
  const branch = requiredText(value, name).trim().replace(/^refs\/heads\//, "");
  if (!branch || /\s/.test(branch)) throw new ToolFailure(`${name} must be a branch name with no spaces, for example "ai/827-hello-world".`);
  return branch;
}

function threadStatusParam(value: unknown): PrThreadStatus | null {
  if (value === undefined || value === null || value === "") return null;
  const match = PR_THREAD_STATUSES.find((st) => typeof value === "string" && st.toLowerCase() === value.trim().toLowerCase());
  if (!match) throw new ToolFailure(`status must be one of ${PR_THREAD_STATUSES.join(", ")}.`);
  return match;
}

/** Pull request comments carry the agent's name in front, like work item comments, so others can tell agents apart. */
export function signPrText(agentName: string, text: string): string {
  const tag = `[${agentName}]`;
  return text.trimStart().toLowerCase().startsWith(tag.toLowerCase()) ? text : `${tag} ${text}`;
}

/** An optional array of work item ids (deduplicated). */
function idList(value: unknown, name: string): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolFailure(`${name} must be a list of work item IDs, for example [812].`);
  return [...new Set(value.map((v) => positiveInt(v, name)))];
}

/** An optional array of strings. */
function stringList(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new ToolFailure(`${name} must be a list of text values.`);
  return value as string[];
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
