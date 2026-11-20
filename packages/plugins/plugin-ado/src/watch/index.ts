/**
 * ADO drives the linked task (requested by Josh, November 2026): agents work
 * like people on a team, so a task stays open until its work item is done in
 * ADO, and anyone else's change to the work item reaches the agent.
 *
 * - A linked task closes when its work item reaches a final state (Completed:
 *   done; Removed: cancelled), and an agent cannot close it before that: the
 *   task is put back to in review (or blocked), with a comment.
 * - A change to a work item by anyone other than the agent on its linked task
 *   (a person, or another agent) is posted on the task and wakes the agent:
 *   state changes, comments, and edits to the title, description, acceptance
 *   criteria or technical notes. A done task is reopened first (a work item
 *   moved out of a final state).
 * - A state change of a work item by anyone other than the owner of its parent
 *   wakes that owner (the agent on the parent's linked task): a Review
 *   approved or asking for changes, a QA Test passed or failed, a Defect
 *   created or ready, a Story completed under a Feature. Owners hand work over
 *   through their children's states (Ready For Review, Ready For Test), which
 *   wakes the child's assignee by the rule above.
 *
 * All agents share one ADO service account, so an agent's change is told
 * apart by the "[Name]" signature the tools write into the history and its
 * comments, or the agent:<Name> tag they set, not by ADO's account name. Events are signals: the history is re-read each
 * time, and plugin state records the last revision and comments handled.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { AdoError, type AdoComment, type AdoWorkItem, type AdoWorkItemUpdate, type JsonPatchOp, type WorkItemSummary } from "../ado/client.js";
import { attributedHtml, htmlToText } from "../tools/html.js";
import { BLOCKED_STATE, COMPLETED_STATE, FINAL_STATES, PLUGIN_SIGNATURE, ROLLUP_RULES } from "../workflow/rules.js";

type Issue = NonNullable<Awaited<ReturnType<PluginContext["issues"]["get"]>>>;

/** The ADO calls this needs (AdoClient has them). */
export interface WatchReader {
  listUpdates(id: number): Promise<AdoWorkItemUpdate[]>;
  listComments(id: number, top?: number): Promise<{ comments: AdoComment[]; totalCount: number }>;
  getWorkItem(id: number): Promise<AdoWorkItem>;
  updateWorkItem(id: number, ops: JsonPatchOp[]): Promise<AdoWorkItem>;
  webUrl(id: number): string;
}

export interface WatchDeps {
  ctx: Pick<PluginContext, "state" | "issues" | "agents" | "logger">;
  findTaskForWorkItem(companyId: string, workItemId: number): Promise<Issue | null>;
  serviceAccountName(companyId: string): Promise<string | null>;
  /** Called once when a work item reaches Completed and its open task is closed (D9: the cost report). */
  onCompleted?(companyId: string, item: WorkItemSummary, task: Issue): Promise<void>;
  /** Called when someone changed the item's state, before anyone is told (A6: auto-assignment). */
  onStateChanged?(companyId: string, item: WorkItemSummary): Promise<void>;
}

/** What was last handled for one work item. */
export interface WatchRecord {
  rev: number;
  /** Ids of comments already handled (the newest 200). */
  seenComments: number[];
}

/** A link as it was before this event refreshed it: the baseline for a work item seen for the first time. */
export interface LinkBaseline {
  rev: number;
  syncedAt: string;
}

export const WORK_ITEM_WAKE_REASON = "ado_work_item_changed";
export const CHILD_WAKE_REASON = "ado_child_changed";

/** Fields whose change is news for the agent, with the name it is told. */
const WATCHED_FIELDS: Record<string, string> = {
  "System.Title": "Title",
  "System.Description": "Description",
  "Microsoft.VSTS.Common.AcceptanceCriteria": "Acceptance criteria",
  "Custom.TechnicalNotes": "Technical notes",
};
const AGENT_TAG = /(?:^|;)\s*agent:([^;]+)/i;
const SIGNED = /^\s*\[([^\]\n]{1,60})\]/;
const MAX_TEXT = 1500;
const COMMENTS_TO_READ = 50;
const MAX_SEEN = 200;
/** Task statuses a wakeup cannot reach. */
const REOPEN_STATUSES = new Set(["done", "backlog"]);
const CLOSED_STATUSES = new Set(["done", "cancelled"]);

const lower = (s: string) => s.trim().toLowerCase();
export const isFinalState = (state: string) => FINAL_STATES.some((f) => lower(f) === lower(state));

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
}

function quote(text: string): string {
  return clip(text)
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
}

function agentFromTags(tags: unknown): string | null {
  const m = typeof tags === "string" ? tags.match(AGENT_TAG) : null;
  return m ? m[1]!.trim() : null;
}

function commentText(c: AdoComment): string {
  return c.format === "markdown" ? c.text : htmlToText(c.text);
}

/** Who made a change, as the agent is told: a person's name, or "<Agent> (agent)". */
interface Actor {
  name: string;
  agent: boolean;
}

export interface ChangeLine {
  rev: number;
  actor: Actor;
  text: string;
  /** For a state change. */
  from?: string | null;
  to?: string;
}

/**
 * Who made a revision. The agent tools sign the history they write ("[Name] ...")
 * and set the agent:<Name> tag in the same revision, so either names the agent,
 * whatever account ADO reports. Failing both, a revision by the configured
 * service account is the agent its tag last named; anything else is a person.
 */
function rollupRule(item: AdoWorkItem) {
  const type = lower(String(item.fields["System.WorkItemType"] ?? ""));
  return ROLLUP_RULES.find((r) => lower(r.type) === type) ?? null;
}

/** A roll-up type in the state where the plugin completes it. */
function rollsUpNow(item: AdoWorkItem): boolean {
  const rule = rollupRule(item);
  const state = lower(String(item.fields["System.State"] ?? ""));
  return !!rule && rule.activeStates.some((st) => lower(st) === state);
}

function revisionActor(u: AdoWorkItemUpdate, tagAgent: string | null, tagSetHere: boolean, serviceAccount: string | null): Actor {
  const history = u.fields["System.History"]?.newValue;
  const signed = typeof history === "string" ? htmlToText(history).match(SIGNED)?.[1]?.trim() : null;
  if (signed) return { name: signed, agent: true };
  if (tagSetHere && tagAgent) return { name: tagAgent, agent: true };
  if (serviceAccount && lower(u.revisedBy) === lower(serviceAccount)) return { name: tagAgent ?? "An agent", agent: true };
  return { name: u.revisedBy || "Someone", agent: false };
}

/** The changes after `sinceRev`, with who made each (see revisionActor). */
export function changesSince(updates: AdoWorkItemUpdate[], sinceRev: number, serviceAccount: string | null): ChangeLine[] {
  let tagAgent: string | null = null;
  const out: ChangeLine[] = [];
  for (const u of updates) {
    const tags = u.fields["System.Tags"];
    const before = tagAgent;
    if (tags && "newValue" in tags) tagAgent = agentFromTags(tags.newValue);
    if (u.rev <= sinceRev) continue;
    const tagSetHere = !!tags && "newValue" in tags && !!tagAgent && (tagAgent !== before || agentFromTags(tags.oldValue) !== tagAgent);
    const actor = revisionActor(u, tagAgent, tagSetHere, serviceAccount);
    const state = u.fields["System.State"];
    if (state && typeof state.newValue === "string") {
      const from = typeof state.oldValue === "string" ? state.oldValue : null;
      out.push({ rev: u.rev, actor, from, to: state.newValue, text: `changed the state${from ? ` from ${from}` : ""} to **${state.newValue}**` });
    }
    for (const [field, label] of Object.entries(WATCHED_FIELDS)) {
      if (u.fields[field] && "newValue" in u.fields[field]!) out.push({ rev: u.rev, actor, text: `edited the ${label.toLowerCase()}` });
    }
  }
  return out;
}

function actorLabel(a: Actor): string {
  return a.agent ? `${a.name} (agent)` : a.name;
}

export function createWorkItemWatcher(deps: WatchDeps) {
  const { ctx } = deps;
  const key = (companyId: string, workItemId: number) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: `wi-watch:${workItemId}` });

  async function agentName(companyId: string, agentId: string): Promise<string | null> {
    const a = await ctx.agents.get(agentId, companyId).catch(() => null);
    return a?.name ?? null;
  }

  /** Reopen if needed, post, wake. A failed wakeup is only logged: the comment is on the task. */
  async function tell(companyId: string, task: Issue, body: string, reason: string, idempotencyKey: string): Promise<void> {
    if (REOPEN_STATUSES.has(task.status)) await ctx.issues.update(task.id, { status: "todo" }, companyId);
    await ctx.issues.createComment(task.id, body, companyId);
    try {
      const res = await ctx.issues.requestWakeup(task.id, companyId, { reason, contextSource: "ado.work-item", idempotencyKey });
      if (!res.queued) ctx.logger.info("Work item wakeup was not queued", { companyId, issueId: task.id, reason });
    } catch (err) {
      ctx.logger.warn("Could not wake the agent for a work item change", {
        companyId,
        issueId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Close a linked task whose work item reached a final state. True when it did. */
  async function closeIfFinal(companyId: string, item: WorkItemSummary, task: Issue): Promise<boolean> {
    if (!isFinalState(item.state)) return false;
    if (CLOSED_STATUSES.has(task.status)) return true;
    const status = lower(item.state) === "removed" ? "cancelled" : "done";
    await ctx.issues.update(task.id, { status }, companyId);
    await ctx.issues.createComment(task.id, `ADO #${item.id} is **${item.state}**, so this task is closed.`, companyId);
    if (status === "done" && deps.onCompleted) {
      await deps.onCompleted(companyId, item, task).catch((err) =>
        ctx.logger.warn("ADO on-completed hook failed", { companyId, workItemId: item.id, error: err instanceof Error ? err.message : String(err) }),
      );
    }
    return true;
  }

  /** Tell the owner of the item's parent about state changes others made to the item. */
  async function tellParentOwner(companyId: string, item: WorkItemSummary, changes: ChangeLine[], parent: AdoWorkItem | null): Promise<string[]> {
    if (!item.parentId) return [];
    const stateChanges = changes.filter((c) => c.to !== undefined);
    if (!stateChanges.length) return [];
    // While the plugin can roll the parent up (it is In Progress), its owner hears only about a Blocked child.
    // Before that (an Epic still Documenting, say) the owner is told as usual.
    if (parent && rollsUpNow(parent) && lower(item.state) !== lower(BLOCKED_STATE)) return [];
    const owner = await deps.findTaskForWorkItem(companyId, item.parentId);
    if (!owner?.assigneeAgentId || CLOSED_STATUSES.has(owner.status)) return [];
    const ownerName = await agentName(companyId, owner.assigneeAgentId);
    const theirs = stateChanges.filter((c) => !(c.actor.agent && !!ownerName && lower(c.actor.name) === lower(ownerName)));
    if (!theirs.length) return [];
    const lines = [`${item.type} [ADO #${item.id} ${item.title}](${item.webUrl}) under your ADO #${item.parentId} changed:`, ""];
    for (const c of theirs) lines.push(`- **${actorLabel(c.actor)}** ${c.text}`);
    lines.push("", `Check the work items under ADO #${item.parentId} and act as your instructions say (this one is now **${item.state}**).`);
    await tell(companyId, owner, lines.join("\n"), CHILD_WAKE_REASON, `ado-child:${item.id}:${item.rev}`);
    return [owner.id];
  }

  /**
   * A4 roll-up: when a child reaches a final state, complete its parent if the
   * parent is a roll-up type in an active state and every child is final (at
   * least one Completed). A conflicting edit is left for the next event.
   */
  async function rollUp(companyId: string, ado: WatchReader, item: WorkItemSummary, parent: AdoWorkItem | null): Promise<number | null> {
    if (!parent || !isFinalState(item.state)) return null;
    const rule = rollupRule(parent);
    const parentState = String(parent.fields["System.State"] ?? "");
    if (!rule || !rule.activeStates.some((s) => lower(s) === lower(parentState))) return null;
    const childIds = (parent.relations ?? [])
      .filter((r) => r.rel === "System.LinkTypes.Hierarchy-Forward")
      .map((r) => Number(r.url.match(/\/workItems\/(\d+)$/i)?.[1]))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (!childIds.length) return null;
    let completed = 0;
    for (const id of childIds) {
      const state = id === item.id ? item.state : String((await ado.getWorkItem(id)).fields["System.State"] ?? "");
      if (!isFinalState(state)) return null;
      if (lower(state) === lower(COMPLETED_STATE)) completed++;
    }
    if (!completed) return null;
    const type = String(parent.fields["System.WorkItemType"] ?? "item");
    try {
      await ado.updateWorkItem(parent.id, [
        { op: "test", path: "/rev", value: parent.rev },
        { op: "replace", path: "/fields/System.State", value: COMPLETED_STATE },
        {
          op: "add",
          path: "/fields/System.History",
          value: attributedHtml(PLUGIN_SIGNATURE, `Completed automatically: every work item under this ${type} is Completed or Removed (last: #${item.id}).`),
        },
      ]);
    } catch (err) {
      if (err instanceof AdoError && (err.status === 409 || err.status === 412)) return null;
      throw err;
    }
    ctx.logger.info("ADO roll-up completed a work item", { companyId, workItemId: parent.id, type, lastChild: item.id });
    return parent.id;
  }

  /**
   * Handle a changed work item. `baseline` is the link as it was before this
   * event refreshed it; it is used only the first time an item is seen.
   */
  async function onWorkItemChanged(
    companyId: string,
    ado: WatchReader,
    item: WorkItemSummary,
    baseline: LinkBaseline | null,
  ): Promise<{ notified: string[]; closed: boolean; rolledUp?: number }> {
    const task = await deps.findTaskForWorkItem(companyId, item.id);
    if (!task) {
      // Unlinked: only its parent's owner could care, so read nothing unless there is one.
      const owner = item.parentId ? await deps.findTaskForWorkItem(companyId, item.parentId) : null;
      if (!owner?.assigneeAgentId || CLOSED_STATUSES.has(owner.status)) return { notified: [], closed: false };
    }
    const stored = ((await ctx.state.get(key(companyId, item.id))) as WatchRecord | null) ?? null;
    // Linked during this very event: there is nothing to compare with yet.
    if (task && !stored && !baseline) return { notified: [], closed: false };
    // An item with no linked task, seen for the first time: this event's revision is the news (its parent's owner may care).
    const sinceRev = stored?.rev ?? baseline?.rev ?? item.rev - 1;
    if (item.rev <= sinceRev && stored) {
      // Nothing new (a redelivery, or a sync of an unchanged item); only make sure a final item's task is closed.
      return { notified: [], closed: task ? await closeIfFinal(companyId, item, task) : false };
    }

    const [updates, { comments }] = await Promise.all([ado.listUpdates(item.id), ado.listComments(item.id, COMMENTS_TO_READ)]);
    const serviceAccount = await deps.serviceAccountName(companyId);
    const seen = new Set(stored?.seenComments ?? []);
    // First time: comments made since the task was linked are new; earlier ones are history.
    const isNew = (c: AdoComment) => (stored ? !seen.has(c.id) : !!baseline && c.createdDate > baseline.syncedAt);
    const newComments = comments.filter(isNew).sort((a, b) => a.id - b.id);
    const changes = changesSince(updates, sinceRev, serviceAccount);

    const notified: string[] = [];
    const closed = task ? await closeIfFinal(companyId, item, task) : false;
    // A6: work released or a builder freed is assigned before its owner is woken, so the owner sees it done.
    if (deps.onStateChanged && changes.some((c) => c.to !== undefined)) {
      await deps.onStateChanged(companyId, item).catch((err) =>
        ctx.logger.warn("ADO state-change hook failed", { companyId, workItemId: item.id, error: err instanceof Error ? err.message : String(err) }),
      );
    }
    const assignee = task?.assigneeAgentId ? await agentName(companyId, task.assigneeAgentId) : null;
    const isAssignee = (a: Actor) => a.agent && !!assignee && lower(a.name) === lower(assignee);

    if (task && !closed && assignee) {
      const theirs = changes.filter((c) => !isAssignee(c.actor));
      const theirComments = newComments
        .map((c) => {
          // Agents' comments are signed "[Name]" by the tool, whatever account ADO reports.
          const signed = commentText(c).match(SIGNED)?.[1]?.trim();
          const byService = !!serviceAccount && lower(c.createdBy) === lower(serviceAccount);
          const actor: Actor = signed
            ? { name: signed, agent: true }
            : byService
              ? { name: "An agent", agent: true }
              : { name: c.createdBy || "Someone", agent: false };
          return { c, actor };
        })
        // The plugin's own notes (auto-assignment, cost reports) are not news to wake anyone for.
        .filter((x) => !isAssignee(x.actor) && lower(x.actor.name) !== lower(PLUGIN_SIGNATURE));
      if (theirs.length || theirComments.length) {
        const lines = [`[ADO #${item.id} ${item.title}](${item.webUrl}) changed:`, ""];
        for (const c of theirs) lines.push(`- **${actorLabel(c.actor)}** ${c.text}`);
        for (const { c, actor } of theirComments) lines.push(`- **${actorLabel(actor)}** commented:`, quote(commentText(c).replace(SIGNED, "").trim()));
        lines.push("", `Read the work item and act on it as your instructions say for its state (now **${item.state}**).`);
        await tell(companyId, task, lines.join("\n"), WORK_ITEM_WAKE_REASON, `ado-wi:${item.id}:${item.rev}`);
        notified.push(task.id);
      }
    }

    // Children report to their parent's owner; a finished child may finish a roll-up parent.
    const parent = item.parentId && changes.some((c) => c.to !== undefined) ? await ado.getWorkItem(item.parentId).catch(() => null) : null;
    notified.push(...(await tellParentOwner(companyId, item, changes, parent)));
    const rolledUp = await rollUp(companyId, ado, item, parent);

    // Saved last, so a failed notice is retried when the event is redelivered. Every comment listed is now handled.
    for (const c of comments) seen.add(c.id);
    const record: WatchRecord = { rev: Math.max(item.rev, sinceRev), seenComments: [...seen].sort((a, b) => a - b).slice(-MAX_SEEN) };
    await ctx.state.set(key(companyId, item.id), record);
    return { notified, closed, ...(rolledUp ? { rolledUp } : {}) };
  }

  /**
   * An agent set its linked task done (or Paperclip did) while the work item
   * is still open in ADO: put it back, so later changes can wake the agent.
   */
  async function onTaskClosed(companyId: string, task: Issue, workItemState: string): Promise<boolean> {
    if (task.status !== "done" || isFinalState(workItemState)) return false;
    const status = lower(workItemState) === "blocked" ? "blocked" : "in_review";
    await ctx.issues.update(task.id, { status }, companyId);
    await ctx.issues.createComment(
      task.id,
      `This task stays open while its ADO work item is **${workItemState}**: it closes by itself when the work item is Completed or Removed. ` +
        `You are woken when the work item, its pull request or its review changes. Until then there is nothing to do; do not mark this task done.`,
      companyId,
    );
    return true;
  }

  return { onWorkItemChanged, onTaskClosed };
}

export type WorkItemWatcher = ReturnType<typeof createWorkItemWatcher>;
