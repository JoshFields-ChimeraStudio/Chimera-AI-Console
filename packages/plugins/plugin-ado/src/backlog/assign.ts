/**
 * Assigning an ADO work item to an agent: the one code path behind the Backlog
 * view's Assign control (`assign-agent`) and the agents' ado_update_assignment
 * tool (and assignTo on ado_create_work_item). Assigning always means the
 * linked Paperclip task, never ADO's Assigned To, so nothing here writes to ADO.
 *
 * Creates the linked task if there is none (title and quoted description from
 * the work item, placed under the ADO parent's linked task and its project when
 * there is one), or reassigns the existing one; puts it in To do; wakes the
 * agent; tells the Backlog page. Assignments of one work item run one after
 * another, and a lost link race cancels the duplicate.
 * See doc/plans/2026-11-17-backlog-view.md ("Assign") and
 * doc/plans/2026-11-17-agent-workflow.md ("Assigning work items").
 */
import type { Issue } from "@paperclipai/plugin-sdk";
import { AdoError, summarize, type AdoClient, type AdoWorkItem, type WorkItemSummary } from "../ado/client.js";
import type { PluginDeps } from "../deps.js";
import type { LinkFeatures } from "../links/index.js";
import { BacklogError } from "./errors.js";
import { buildTaskDescription } from "./description.js";
import { notifyBacklogChanged } from "./notify.js";
import type { ProjectKey, WorkItemCacheRepository } from "./repository.js";

/** Plugin state (issue scope) recording how the task's current agent came to hold it. */
export const HOLDER_STATE_KEY = "ado-assignment-holder";

export interface HolderRecord {
  agentId: string;
  /** "claimed": the agent assigned the task to itself under the claim rule. */
  kind: "claimed" | "assigned";
  byAgentId?: string;
  byUserId?: string;
}

/** Why an agent cannot take work, as far as the plugin can tell; null if it can. */
export function unassignableReason(agent: { name: string; status?: string | null }): string | null {
  if (agent.status === "terminated") return `${agent.name} has been terminated and cannot take work`;
  if (agent.status === "pending_approval") return `${agent.name} is awaiting approval and cannot take work yet`;
  return null;
}

/** Task statuses an assignment reopens to To do (see the Backlog plan, "Assign"). */
const REOPEN_STATUSES = new Set(["backlog", "done", "cancelled"]);

export interface AssignResult {
  issueId: string;
  identifier: string | null;
  created: boolean;
}

export interface AssignDetails extends AssignResult {
  /** The task's agent before this assignment (null if none or no task). */
  previousAgentId: string | null;
  /** False when the task already had this agent and status, so nothing changed. */
  changed: boolean;
  /** Where a new task was placed. */
  parentIssueId: string | null;
  projectId: string | null;
  /** Set when the note could not be posted (the assignment stands). */
  noteError?: string;
}

/** What the caller may inspect before the assignment goes ahead. */
export interface AssignmentFacts {
  /** The linked task, or null if the work item has none yet. */
  task: Issue | null;
  /** The work item as ADO has it now (live read): type, tags and parent. */
  item(): Promise<{ type: string; tags: unknown; parentId: number | null }>;
  /** The linked task of the work item's ADO parent, by a live read of System.Parent. */
  parentTask(): Promise<Issue | null>;
  /** How the task's current agent came to hold it, if the plugin recorded it (and it is still that agent). */
  holder(): Promise<HolderRecord | null>;
}

export interface AssignRequest {
  companyId: string;
  workItemId: number;
  /** Null removes the agent (Backlog only). */
  agentId: string | null;
  /** Who is assigning: a board user or an agent. Recorded on the task changes and the wakeup. */
  actor: { actorUserId: string | null } | { actorAgentId: string };
  /**
   * Refuse by throwing a BacklogError. Runs inside the per-item lock, before anything is written,
   * and again against the winning task if another link wins a race. `claimed: true` records that
   * the agent took the item for itself.
   */
  authorize?(facts: AssignmentFacts): Promise<{ claimed?: boolean } | void>;
  /** Project for a new task with no linked parent task (an agent's current task's project). */
  fallbackProjectId?(): Promise<string | null>;
  /** Posted on the linked task, as this agent, before the wakeup. */
  note?: { body: string; authorAgentId: string } | null;
  /** Wakeup context source, for the run's "why did this start". */
  wakeSource: string;
}

export interface Assigner {
  assign(request: AssignRequest): Promise<AssignDetails>;
  /** Reads the item live; a 404 drops it from the cache and becomes a BacklogError. */
  readWorkItem(companyId: string, ado: AdoClient, key: ProjectKey, id: number): Promise<AdoWorkItem>;
}

export interface AssignerOptions {
  deps: PluginDeps;
  links: LinkFeatures;
  repo: WorkItemCacheRepository;
  projectKey(companyId: string): Promise<ProjectKey | null>;
  processWorkItem(companyId: string, item: WorkItemSummary, source: string): Promise<void>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createAssigner(options: AssignerOptions): Assigner {
  const { deps, links, repo } = options;
  const { ctx } = deps;
  /** One assignment per work item at a time, so a double click cannot create two tasks. */
  const locks = new Map<string, Promise<unknown>>();

  async function readWorkItem(companyId: string, ado: AdoClient, key: ProjectKey, id: number): Promise<AdoWorkItem> {
    try {
      return await ado.getWorkItem(id);
    } catch (err) {
      if (err instanceof AdoError && err.status === 404) {
        await repo.remove(companyId, key, id).catch(() => {});
        await links.onWorkItemMissing?.(companyId, id, "work-item-page").catch(() => {});
        throw new BacklogError(`ADO #${id} was not found in project ${key.project}. It may have been deleted or moved.`);
      }
      throw err;
    }
  }

  async function wake(companyId: string, issue: Issue, request: AssignRequest): Promise<void> {
    // The plugin issue API does not wake the assignee (only the REST routes do), so ask for it.
    try {
      const res = await ctx.issues.requestWakeup(issue.id, companyId, {
        reason: "issue_assigned",
        contextSource: request.wakeSource,
        ...request.actor,
      });
      if (!res.queued) ctx.logger.info("Assignment wakeup was not queued", { companyId, issueId: issue.id });
    } catch (err) {
      // The assignment stands; the agent picks the task up on its next heartbeat.
      ctx.logger.warn("Could not wake the assigned agent", { companyId, issueId: issue.id, error: errorText(err) });
    }
  }

  const holderKey = (issueId: string) => ({ scopeKind: "issue" as const, scopeId: issueId, stateKey: HOLDER_STATE_KEY });

  async function readHolder(task: Issue | null): Promise<HolderRecord | null> {
    if (!task?.assigneeAgentId) return null;
    const value = (await ctx.state.get(holderKey(task.id)).catch(() => null)) as HolderRecord | null;
    // Only valid while the same agent holds the task (it may have been reassigned outside the plugin).
    return value && typeof value === "object" && value.agentId === task.assigneeAgentId ? value : null;
  }

  async function writeHolder(issue: Issue, request: AssignRequest, claimed: boolean): Promise<void> {
    if (!request.agentId) return;
    const actor = request.actor;
    const record: HolderRecord = claimed
      ? { agentId: request.agentId, kind: "claimed" }
      : { agentId: request.agentId, kind: "assigned", ...("actorAgentId" in actor ? { byAgentId: actor.actorAgentId } : actor.actorUserId ? { byUserId: actor.actorUserId } : {}) };
    await ctx.state.set(holderKey(issue.id), record).catch((err) =>
      ctx.logger.warn("Could not record how an ADO task was assigned", { issueId: issue.id, error: errorText(err) }),
    );
  }

  async function postNote(companyId: string, issue: Issue, request: AssignRequest): Promise<string | undefined> {
    if (!request.note) return undefined;
    try {
      await ctx.issues.createComment(issue.id, request.note.body, companyId, { authorAgentId: request.note.authorAgentId });
      return undefined;
    } catch (err) {
      ctx.logger.warn("Could not post the assignment note", { companyId, issueId: issue.id, error: errorText(err) });
      return errorText(err);
    }
  }

  async function assignNow(request: AssignRequest): Promise<AssignDetails> {
    const { companyId, workItemId, agentId } = request;
    const key = await options.projectKey(companyId);
    if (!key) throw new BacklogError("The Azure DevOps plugin is not configured for this company");
    if (agentId !== null) {
      const agent = await ctx.agents.get(agentId, companyId);
      if (!agent) throw new BacklogError("That agent was not found in this company");
      const problem = unassignableReason(agent);
      if (problem) throw new BacklogError(problem);
    }
    const actor = request.actor;

    let ado: AdoClient | null = null;
    const client = async () => (ado ??= await deps.adoClient(companyId));
    let live: { item: AdoWorkItem; summary: WorkItemSummary } | null = null;
    async function readLive() {
      if (!live) {
        const c = await client();
        const item = await readWorkItem(companyId, c, key!, workItemId);
        const summary = summarize(item, c.webUrl(workItemId));
        await options.processWorkItem(companyId, summary, "assign-agent");
        live = { item, summary };
      }
      return live;
    }
    const item = async () => {
      const { item: wi, summary } = await readLive();
      return { type: summary.type, tags: wi.fields["System.Tags"], parentId: summary.parentId };
    };
    let parentTaskMemo: Promise<Issue | null> | null = null;
    // Rights depend on the parent, so it is read live from ADO, never from the cache.
    const parentTask = () =>
      (parentTaskMemo ??= (async () => {
        const parentId = (await readLive()).summary.parentId;
        return parentId ? links.findTaskForWorkItem(companyId, parentId) : null;
      })());
    const factsFor = (t: Issue | null): AssignmentFacts => ({ task: t, item, parentTask, holder: () => readHolder(t) });

    let task = await links.findTaskForWorkItem(companyId, workItemId);
    if (!task && agentId === null) throw new BacklogError(`ADO #${workItemId} has no linked task, so there is no agent to remove`);
    if (!task) await readLive(); // needed to create the task; also gives the parent
    let claimed = !!(await request.authorize?.(factsFor(task)))?.claimed;
    const previousAgentId = task?.assigneeAgentId ?? null;

    if (!task) {
      const { item, summary } = await readLive();
      const origin = await links.originFor(companyId, workItemId);
      if (!origin) throw new BacklogError("The Azure DevOps plugin is not configured for this company");
      const parent = await parentTask().catch(() => null);
      const projectId = parent ? (parent.projectId ?? null) : ((await request.fallbackProjectId?.()) ?? null);
      const created = await ctx.issues.create({
        companyId,
        title: summary.title || `ADO #${workItemId}`,
        description: buildTaskDescription(item, summary.webUrl),
        status: "todo",
        assigneeAgentId: agentId!,
        ...(parent ? { parentId: parent.id } : {}),
        ...(projectId ? { projectId } : {}),
        originKind: origin.originKind as never,
        originId: origin.originId,
        actor,
      });
      const placed = { parentIssueId: parent?.id ?? null, projectId };
      const done = async (issue: Issue): Promise<AssignDetails> => {
        await writeHolder(issue, request, claimed);
        const noteError = await postNote(companyId, issue, request);
        await wake(companyId, issue, request);
        return {
          issueId: issue.id,
          identifier: issue.identifier ?? null,
          created: true,
          previousAgentId: null,
          changed: true,
          ...placed,
          ...(noteError ? { noteError } : {}),
        };
      };
      let attached: Awaited<ReturnType<LinkFeatures["attachCreatedTask"]>>;
      try {
        attached = await links.attachCreatedTask(companyId, created.id, summary);
      } catch (err) {
        // The task carries the item's origin, so it is still found as the linked task next time.
        ctx.logger.error("Created a task for an ADO work item but could not store the link row", {
          companyId,
          issueId: created.id,
          workItemId,
          error: errorText(err),
        });
        return done(created);
      }
      if (attached.ok) return done(created);
      // Another task was linked to the item meanwhile: retire ours and assign that one instead.
      ctx.logger.warn("Another task was linked to the ADO work item first; cancelling the duplicate", {
        companyId,
        workItemId,
        duplicateIssueId: created.id,
        linkedIssueId: attached.winnerIssueId,
      });
      await ctx.issues
        .update(created.id, { status: "cancelled", assigneeAgentId: null, originKind: "manual" as never, originId: null }, companyId, actor)
        .catch((err) => ctx.logger.error("Could not cancel the duplicate task", { issueId: created.id, error: errorText(err) }));
      task = await ctx.issues.get(attached.winnerIssueId, companyId);
      if (!task) throw new BacklogError(`ADO #${workItemId} is already linked to a task this plugin cannot read`);
      // The rights were checked against "no task"; check them again against the winner.
      claimed = !!(await request.authorize?.(factsFor(task)))?.claimed;
    }

    const patch: Parameters<typeof ctx.issues.update>[1] = {};
    if ((task.assigneeAgentId ?? null) !== agentId) patch.assigneeAgentId = agentId;
    if (agentId !== null) {
      if (task.assigneeUserId) patch.assigneeUserId = null;
      // Handing the item to an agent means work: a parked or closed task goes back to To do.
      if (REOPEN_STATUSES.has(task.status)) patch.status = "todo";
    } else if (task.status === "in_progress" && patch.assigneeAgentId !== undefined) {
      // Nobody is working on it any more: do not leave it in progress with no assignee.
      patch.status = "todo";
    }
    let updated = task;
    const changed = Object.keys(patch).length > 0;
    if (changed) updated = await ctx.issues.update(task.id, patch, companyId, actor);
    // A no-op (same agent) keeps the existing record, so re-claiming cannot launder a claim and vice versa.
    if (changed) await writeHolder(updated, request, claimed);
    const noteError = agentId !== null ? await postNote(companyId, updated, request) : undefined;
    if (changed && agentId !== null) await wake(companyId, updated, request);
    ctx.logger.info("ADO work item assigned", { companyId, workItemId, issueId: task.id, agentId });
    return {
      issueId: updated.id,
      identifier: updated.identifier ?? null,
      created: false,
      previousAgentId,
      changed,
      parentIssueId: null,
      projectId: null,
      ...(noteError ? { noteError } : {}),
    };
  }

  /** Runs `fn` after any assignment of the same work item already in progress. */
  async function serialized<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(lockKey) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    locks.set(lockKey, tail);
    try {
      return await run;
    } finally {
      if (locks.get(lockKey) === tail) locks.delete(lockKey);
    }
  }

  return {
    readWorkItem,
    async assign(request) {
      const result = await serialized(`${request.companyId}\u0000${request.workItemId}`, () => assignNow(request));
      notifyBacklogChanged(ctx, request.companyId, { reason: "assign", workItemId: request.workItemId });
      return result;
    },
  };
}
