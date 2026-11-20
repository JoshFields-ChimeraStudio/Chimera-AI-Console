/**
 * Backlog view: the plugin side (doc/plans/2026-11-17-backlog-view.md, "Plugin contract").
 *
 * - a cache of the project's work items (ado_work_items), written by every changed
 *   work item (live event, catch-up, full sync) and read by the `backlog` data;
 * - the `work-item` data, read live from ADO, with ADO HTML converted to Markdown;
 * - `sync-backlog` (the full mirror itself runs in worker.ts, next to the catch-up it shares);
 * - `assign-agent`, which creates or reuses the linked task (A2 link) and assigns it (./assign.ts,
 *   shared with the agents' ado_update_assignment tool).
 * Nothing here writes to ADO.
 */
import { createProjectRouter } from "../projects/index.js";
import type { Issue } from "@paperclipai/plugin-sdk";
import { summarize, type AdoClient, type AdoWorkItem, type WorkItemSummary } from "../ado/client.js";
import type { PluginDeps, WorkItemChangedHandler } from "../deps.js";
import { orgName, parseWorkItemId, type LinkFeatures } from "../links/index.js";
import { createAssigner, type Assigner, type AssignResult } from "./assign.js";
import { FIELD, descriptionHtml } from "./description.js";
import { BacklogError } from "./errors.js";
import { htmlToMarkdown, textToMarkdown } from "./markdown.js";
import { sqlWorkItemCacheRepository, type CachedWorkItem, type ProjectKey, type StateCategory, type WorkItemCacheRepository } from "./repository.js";
import { createWorkItemTypeCache } from "./work-item-types.js";
import { joshWaitFor } from "../workflow/rules.js";

export { BacklogError } from "./errors.js";
export { FIELD, buildTaskDescription } from "./description.js";
export type { AssignResult, AssignDetails, Assigner } from "./assign.js";

export const BACKLOG_DATA_KEYS = { backlog: "backlog", workItem: "work-item", needsJosh: "needs-josh" } as const;
export const BACKLOG_ACTION_KEYS = { sync: "sync-backlog", assign: "assign-agent" } as const;

/** The comments API returns at most 200 per call; the page shows the newest 200. */
const MAX_COMMENTS = 200;

export interface LinkedTaskSummary {
  issueId: string;
  identifier: string | null;
  status: string;
  assigneeAgentId: string | null;
}

export interface LastFullSync {
  startedAt: string;
  finishedAt: string;
  trigger: string;
  changed: number;
  removed: number;
  error?: string;
}

export interface BacklogItem {
  id: number;
  parentId: number | null;
  type: string;
  typeColor: string | null;
  title: string;
  state: string;
  stateCategory: StateCategory | null;
  stackRank: number | null;
  url: string;
  linkedTask: LinkedTaskSummary | null;
}

/** A work item waiting for Josh (D4), for the toolbar's "Needs you" list. */
export interface NeedsJoshItem {
  id: number;
  type: string;
  title: string;
  state: string;
  /** What Josh is asked to do. */
  action: string;
  url: string;
  /** When ADO last changed the item (roughly when it started waiting), if known. */
  since: string | null;
  linkedTask: LinkedTaskSummary | null;
}

export interface NeedsJoshData {
  configured: boolean;
  items: NeedsJoshItem[];
}

export interface BacklogData {
  configured: boolean;
  syncing: boolean;
  lastSync: { finishedAt: string; trigger: string; changed: number; error?: string } | null;
  items: BacklogItem[];
}

export interface WorkItemPullRequest {
  id: number;
  title: string;
  status: string;
  repository: string;
  url: string;
}

export interface WorkItemRelated {
  id: number;
  relation: string;
  type: string | null;
  title: string | null;
  state: string | null;
  url: string;
}

export interface WorkItemComment {
  id: number;
  author: string;
  createdDate: string;
  markdown: string;
}

export interface WorkItemData {
  id: number;
  type: string;
  typeColor: string | null;
  title: string;
  state: string;
  stateCategory: string | null;
  url: string;
  descriptionMarkdown: string | null;
  acceptanceCriteriaMarkdown: string | null;
  technicalNotesMarkdown: string | null;
  pullRequests: WorkItemPullRequest[];
  related: WorkItemRelated[];
  comments: WorkItemComment[];
  linkedTask: LinkedTaskSummary | null;
}

export type SyncStartResult = { started: true } | { started: false; reason: string };

export interface BacklogFeatures {
  /** Upserts the cache row (never to an older rev). Called from processWorkItem. */
  onWorkItemChanged: WorkItemChangedHandler;
  /** ADO answered 404: the item is gone or not visible, so drop it from the cache. */
  onWorkItemMissing(companyId: string, workItemId: number): Promise<void>;
  /**
   * After a complete full sync: delete the rows of `key` whose IDs the sync's WIQL pages did not
   * return (`seen`) and that nothing wrote since `writtenBefore`. Returns the IDs actually deleted.
   */
  removeNotSeen(companyId: string, key: ProjectKey, seen: ReadonlySet<number>, writtenBefore: string): Promise<number[]>;
  /** The org and project the company's settings name now, or null if not configured. */
  projectKey(companyId: string): Promise<ProjectKey | null>;
  /** The one assignment path, shared with the agent tools. */
  assigner: Assigner;
}

export interface BacklogOptions {
  repo?: WorkItemCacheRepository;
  /** The single path for a changed work item (worker.ts processWorkItem). */
  processWorkItem(companyId: string, item: WorkItemSummary, source: string): Promise<void>;
  syncStatus(companyId: string): Promise<{ syncing: boolean; lastSync: LastFullSync | null }>;
  startFullSync(companyId: string): Promise<SyncStartResult>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function linkedTaskSummary(issue: Issue | null | undefined): LinkedTaskSummary | null {
  if (!issue) return null;
  return { issueId: issue.id, identifier: issue.identifier ?? null, status: issue.status, assigneeAgentId: issue.assigneeAgentId ?? null };
}

/** Backlog order: by StackRank (unranked last), then by ID. */
function byBacklogOrder(a: { stackRank: number | null; id: number }, b: { stackRank: number | null; id: number }): number {
  if (a.stackRank !== b.stackRank) {
    if (a.stackRank === null) return 1;
    if (b.stackRank === null) return -1;
    return a.stackRank - b.stackRank;
  }
  return a.id - b.id;
}

const PR_ARTIFACT = /^vstfs:\/\/\/Git\/PullRequestId\/([^/]+)\/([^/]+)\/(\d+)$/i;

/** Pull requests linked to a work item (ArtifactLink relations vstfs:///Git/PullRequestId/<project>%2F<repo>%2F<id>). */
export function pullRequestRefs(item: AdoWorkItem): Array<{ projectId: string; repositoryId: string; pullRequestId: number }> {
  const out: Array<{ projectId: string; repositoryId: string; pullRequestId: number }> = [];
  const seen = new Set<string>();
  for (const r of item.relations ?? []) {
    if (r.rel !== "ArtifactLink") continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(r.url);
    } catch {
      continue;
    }
    const m = decoded.match(PR_ARTIFACT);
    if (!m) continue;
    const key = `${m[2]!.toLowerCase()}/${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ projectId: m[1]!, repositoryId: m[2]!, pullRequestId: Number(m[3]) });
  }
  return out;
}

const RELATION_NAMES: Record<string, string> = {
  "System.LinkTypes.Hierarchy-Reverse": "Parent",
  "System.LinkTypes.Hierarchy-Forward": "Child",
  "System.LinkTypes.Related": "Related",
};

/** Work item links (parent, children, related and other link types), in that order. */
export function relatedRefs(item: AdoWorkItem): Array<{ id: number; relation: string }> {
  const out: Array<{ id: number; relation: string }> = [];
  const seen = new Set<string>();
  for (const r of item.relations ?? []) {
    const m = r.url.match(/\/_apis\/wit\/workItems\/(\d+)$/i);
    if (!m || (!r.rel.startsWith("System.LinkTypes.") && !r.rel.startsWith("Microsoft.VSTS."))) continue;
    const name = typeof r.attributes?.name === "string" && r.attributes.name ? r.attributes.name : r.rel;
    const relation = RELATION_NAMES[r.rel] ?? name;
    const id = Number(m[1]);
    const key = `${relation}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, relation });
  }
  const rank = (rel: string) => (rel === "Parent" ? 0 : rel === "Child" ? 1 : rel === "Related" ? 2 : 3);
  return out.sort((a, b) => rank(a.relation) - rank(b.relation));
}

/**
 * A comment as safe Markdown. Markdown comments (format "markdown") go through ADO's
 * own HTML rendering and the same HTML conversion; without one, they are shown as plain text.
 */
export function commentMarkdown(c: { text: string; format: string; renderedText: string | null }): string {
  if (c.format === "markdown") return (c.renderedText ? htmlToMarkdown(c.renderedText) : textToMarkdown(c.text)) ?? "";
  return htmlToMarkdown(c.text) ?? "";
}

export function registerBacklogFeatures(deps: PluginDeps, links: LinkFeatures, options: BacklogOptions): BacklogFeatures {
  const { ctx } = deps;
  const repo = options.repo ?? sqlWorkItemCacheRepository(ctx);
  const types = createWorkItemTypeCache(deps.now, (err) =>
    ctx.logger.warn("Could not read ADO work item types; colours and state categories are missing until it works", { error: errorText(err) }),
  );

  async function projectKey(companyId: string): Promise<ProjectKey | null> {
    const settings = await deps.settings(companyId);
    return settings ? { org: orgName(settings.orgUrl), project: settings.project } : null;
  }

  async function cacheRow(companyId: string, item: WorkItemSummary): Promise<CachedWorkItem> {
    // The client is only needed when the type cache must be (re)filled.
    const meta = await types.lookup(companyId, () => deps.adoClient(companyId), item.type, item.state);
    return {
      id: item.id,
      parentId: item.parentId,
      type: item.type,
      typeColor: meta.typeColor,
      title: item.title,
      state: item.state,
      stateCategory: meta.stateCategory,
      stackRank: item.stackRank,
      url: item.webUrl,
      rev: item.rev,
      changedDate: item.changedDate,
      syncedAt: new Date(deps.now()).toISOString(),
    };
  }

  const onWorkItemChanged: WorkItemChangedHandler = async (companyId, item) => {
    const key = await projectKey(companyId);
    if (!key) return;
    await repo.upsert(companyId, key, await cacheRow(companyId, item));
  };

  async function onWorkItemMissing(companyId: string, workItemId: number): Promise<void> {
    const key = await projectKey(companyId);
    if (key) await repo.remove(companyId, key, workItemId);
  }

  async function removeNotSeen(companyId: string, key: ProjectKey, seen: ReadonlySet<number>, writtenBefore: string): Promise<number[]> {
    const deleted: number[] = [];
    for (const id of await repo.listSyncedBefore(companyId, key, writtenBefore)) {
      if (seen.has(id)) continue;
      // Guarded by the write time too, so a row a live event wrote meanwhile stays.
      if ((await repo.removeIfSyncedBefore(companyId, key, id, writtenBefore)) > 0) deleted.push(id);
    }
    return deleted;
  }

  const assigner = createAssigner({ deps, links, repo, projectKey, processWorkItem: options.processWorkItem, projects: createProjectRouter(deps) });
  const readWorkItem = assigner.readWorkItem;

  async function backlog(companyId: string): Promise<BacklogData> {
    const key = await projectKey(companyId);
    const status = await options.syncStatus(companyId);
    const lastSync = status.lastSync
      ? {
          finishedAt: status.lastSync.finishedAt,
          trigger: status.lastSync.trigger,
          changed: status.lastSync.changed,
          ...(status.lastSync.error ? { error: status.lastSync.error } : {}),
        }
      : null;
    if (!key) return { configured: false, syncing: status.syncing, lastSync, items: [] };
    const [rows, tasks] = await Promise.all([repo.list(companyId, key), links.listLinkedTasks(companyId)]);
    const items = rows.sort(byBacklogOrder).map((r) => ({
      id: r.id,
      parentId: r.parentId,
      type: r.type,
      typeColor: r.typeColor,
      title: r.title,
      state: r.state,
      stateCategory: r.stateCategory,
      stackRank: r.stackRank,
      url: r.url,
      linkedTask: linkedTaskSummary(tasks.get(r.id)),
    }));
    return { configured: true, syncing: status.syncing, lastSync, items };
  }

  async function needsJosh(companyId: string): Promise<NeedsJoshData> {
    const key = await projectKey(companyId);
    if (!key) return { configured: false, items: [] };
    const [rows, tasks] = await Promise.all([repo.list(companyId, key), links.listLinkedTasks(companyId)]);
    const items: NeedsJoshItem[] = [];
    for (const r of rows) {
      const action = joshWaitFor(r.type, r.state);
      if (!action) continue;
      items.push({ id: r.id, type: r.type, title: r.title, state: r.state, action, url: r.url, since: r.changedDate, linkedTask: linkedTaskSummary(tasks.get(r.id)) });
    }
    // Oldest first: the longest wait is at the top.
    items.sort((a, b) => (a.since ?? "").localeCompare(b.since ?? "") || a.id - b.id);
    return { configured: true, items };
  }

  async function resolvePullRequests(ado: AdoClient, item: AdoWorkItem): Promise<WorkItemPullRequest[]> {
    return Promise.all(
      pullRequestRefs(item).map(async (ref) => {
        try {
          const pr = await ado.getPullRequest(ref.repositoryId, ref.pullRequestId);
          const repository = pr.repositoryName || pr.repositoryId;
          return { id: ref.pullRequestId, title: pr.title, status: pr.status, repository, url: ado.pullRequestWebUrl(repository, ref.pullRequestId) };
        } catch (err) {
          // Deleted, in another project or not visible: keep the link, say so.
          ctx.logger.info("Linked pull request could not be read", { pullRequestId: ref.pullRequestId, error: errorText(err) });
          return {
            id: ref.pullRequestId,
            title: `Pull request ${ref.pullRequestId}`,
            status: "unavailable",
            repository: ref.repositoryId,
            url: ado.pullRequestWebUrl(ref.repositoryId, ref.pullRequestId),
          };
        }
      }),
    );
  }

  async function resolveRelated(companyId: string, ado: AdoClient, key: ProjectKey, item: AdoWorkItem): Promise<WorkItemRelated[]> {
    const refs = relatedRefs(item);
    if (refs.length === 0) return [];
    const ids = [...new Set(refs.map((r) => r.id))];
    const known = new Map<number, { type: string; title: string; state: string }>();
    for (const row of await repo.getMany(companyId, key, ids)) known.set(row.id, row);
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) {
      try {
        for (const summary of await ado.getWorkItemSummaries(missing)) {
          known.set(summary.id, summary);
          // Fill the cache through the one path for changed items.
          await options.processWorkItem(companyId, summary, "work-item-page").catch(() => {});
        }
      } catch (err) {
        ctx.logger.warn("Could not read related work items", { workItemId: item.id, error: errorText(err) });
      }
    }
    return refs.map((r) => {
      const k = known.get(r.id);
      return { id: r.id, relation: r.relation, type: k?.type ?? null, title: k?.title ?? null, state: k?.state ?? null, url: ado.webUrl(r.id) };
    });
  }

  async function workItem(companyId: string, workItemId: number): Promise<WorkItemData> {
    const key = await projectKey(companyId);
    if (!key) throw new BacklogError("The Azure DevOps plugin is not configured for this company");
    const ado = await deps.adoClient(companyId);
    const item = await readWorkItem(companyId, ado, key, workItemId);
    const summary = summarize(item, ado.webUrl(workItemId));
    // Refresh the cache row (and the link) through the one path for changed items.
    await options.processWorkItem(companyId, summary, "work-item-page");

    const [meta, pullRequests, related, comments, task] = await Promise.all([
      types.lookup(companyId, async () => ado, summary.type, summary.state),
      resolvePullRequests(ado, item),
      resolveRelated(companyId, ado, key, item),
      ado.listComments(workItemId, MAX_COMMENTS),
      links.findTaskForWorkItem(companyId, workItemId),
    ]);
    return {
      id: summary.id,
      type: summary.type,
      typeColor: meta.typeColor,
      title: summary.title,
      state: summary.state,
      stateCategory: meta.stateCategory,
      url: summary.webUrl,
      descriptionMarkdown: htmlToMarkdown(descriptionHtml(item)),
      acceptanceCriteriaMarkdown: htmlToMarkdown(item.fields[FIELD.acceptanceCriteria]),
      technicalNotesMarkdown: htmlToMarkdown(item.fields[FIELD.technicalNotes]),
      pullRequests,
      related,
      comments: comments.comments
        .map((c) => ({ id: c.id, author: c.createdBy, createdDate: c.createdDate, markdown: commentMarkdown(c) }))
        .sort((a, b) => Date.parse(b.createdDate) - Date.parse(a.createdDate) || b.id - a.id),
      linkedTask: linkedTaskSummary(task),
    };
  }

  function companyIdFrom(params: Record<string, unknown>, hostCompanyId?: string | null): string {
    const id = hostCompanyId || params.companyId;
    if (typeof id !== "string" || !id) throw new Error("companyId is required");
    return id;
  }

  function workItemIdFrom(params: Record<string, unknown>): number {
    const id = parseWorkItemId(params.workItemId);
    if (id === null) throw new BacklogError("workItemId must be a work item ID, for example 123");
    return id;
  }

  ctx.data.register(BACKLOG_DATA_KEYS.backlog, async (params) => backlog(companyIdFrom(params)));
  ctx.data.register(BACKLOG_DATA_KEYS.needsJosh, async (params) => needsJosh(companyIdFrom(params)));

  ctx.data.register(BACKLOG_DATA_KEYS.workItem, async (params) => {
    const companyId = companyIdFrom(params);
    const workItemId = workItemIdFrom(params);
    try {
      return await workItem(companyId, workItemId);
    } catch (err) {
      if (!(err instanceof BacklogError)) ctx.logger.error("Reading an ADO work item failed", { companyId, workItemId, error: errorText(err) });
      throw err;
    }
  });

  ctx.actions.register(BACKLOG_ACTION_KEYS.sync, async (params, context): Promise<SyncStartResult> => {
    return options.startFullSync(companyIdFrom(params, context?.companyId));
  });

  ctx.actions.register(BACKLOG_ACTION_KEYS.assign, async (params, context): Promise<AssignResult> => {
    const companyId = companyIdFrom(params, context?.companyId);
    // The bridge only checks that the caller can access the company, and the host's
    // issues.create/update skip the tasks:assign permission the REST routes enforce.
    // So only a signed-in board user may assign; agents (and system calls) may not.
    if (context?.actor?.type !== "user" || !context.actor.userId) {
      throw new BacklogError("Only a board user can assign ADO work items to agents");
    }
    const workItemId = workItemIdFrom(params);
    const raw = params.agentId;
    if (raw !== null && raw !== undefined && (typeof raw !== "string" || !raw.trim())) throw new BacklogError("agentId must be an agent ID or null");
    const agentId = typeof raw === "string" ? raw.trim() : null;
    try {
      const userId = context.actor.userId;
      const result = await assigner.assign({ companyId, workItemId, agentId, actor: { actorUserId: userId }, wakeSource: "plugin.ado.assign-agent" });
      return { issueId: result.issueId, identifier: result.identifier, created: result.created };
    } catch (err) {
      if (!(err instanceof BacklogError)) ctx.logger.error("Assigning an ADO work item failed", { companyId, workItemId, agentId, error: errorText(err) });
      throw err;
    }
  });

  return { onWorkItemChanged, onWorkItemMissing, removeNotSeen, projectKey, assigner };
}

