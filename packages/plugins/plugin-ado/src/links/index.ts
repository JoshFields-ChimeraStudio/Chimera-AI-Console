/**
 * A2: the link between a Paperclip task and its ADO work item.
 * See doc/plans/2026-11-14-ado-integration.md, decision 6.
 *
 * Two records make one link:
 * - on the task, originKind = ADO_LINK_ORIGIN_KIND and originId = "<org>/<project>/<id>"
 *   (core filters and searches on these), and
 * - a row in the plugin's ado_links table with the work item's current type, state,
 *   title and revision, for the chip and for reverse lookups.
 */
import { notifyBacklogChanged } from "../backlog/notify.js";
import type { Issue } from "@paperclipai/plugin-sdk";
import { AdoError, type WorkItemSummary } from "../ado/client.js";
import type { PluginDeps, WorkItemChangedHandler } from "../deps.js";
import { sqlLinkRepository, type LinkRepository, type WorkItemKey } from "./repository.js";

/** Must match LINKED_TASK_ORIGIN_KINDS in packages/shared/src/issue-creation-source.ts. */
export const ADO_LINK_ORIGIN_KIND = "plugin:chimera.plugin-ado:workitem";
/** The only other origin a task may have when it is linked; unlinking restores it. */
const PLAIN_TASK_ORIGIN_KIND = "manual";

export const LINK_DATA_KEYS = { issueLink: "issue-link" } as const;
export const LINK_ACTION_KEYS = { link: "link-work-item", unlink: "unlink-work-item" } as const;

export interface AdoLink {
  issueId: string;
  org: string;
  project: string;
  workItemId: number;
  type: string;
  state: string;
  /** Work item title as last seen in ADO. */
  title?: string;
  url: string;
  rev: number;
  syncedAt: string;
  /** Set when ADO last answered "not found" for the item (deleted, moved or not visible); cleared when it is seen again. */
  missingAt?: string | null;
}

export interface LinkFeatures {
  /** The ADO work item linked to a task, if any. Used by the A8 tools to default to the task's item. */
  findLinkByIssue(companyId: string, issueId: string): Promise<AdoLink | null>;
  /** The link row of a work item in the configured project, if any. */
  findLinkByWorkItem(companyId: string, workItemId: number): Promise<AdoLink | null>;
  /** Refreshes the stored state of a linked task. Does not create tasks (that is A3). */
  onWorkItemChanged: WorkItemChangedHandler;
  /** ADO answered 404 for a work item: mark its link, never delete it silently. */
  onWorkItemMissing?(companyId: string, workItemId: number, source: string): Promise<void>;
  /** The task linked to a work item: by the task's origin (the indexed key), else by the link row. */
  findTaskForWorkItem(companyId: string, workItemId: number): Promise<Issue | null>;
  /** Every linked task of the company's configured org and project, by work item ID. */
  listLinkedTasks(companyId: string): Promise<Map<number, Issue>>;
  /** The origin a task linked to this work item carries, or null if the plugin is not configured. */
  originFor(companyId: string, workItemId: number): Promise<{ originKind: string; originId: string } | null>;
  /**
   * Store the link row for a task just created with the work item's origin.
   * Another task that won a race for the same item comes back as `winnerIssueId`.
   */
  attachCreatedTask(companyId: string, issueId: string, item: WorkItemSummary): Promise<{ ok: true } | { ok: false; winnerIssueId: string }>;
}

export interface IssueLinkData {
  configured: boolean;
  link: AdoLink | null;
}

export type LinkResult = { ok: true; link: AdoLink } | { ok: false; error: string };
export type UnlinkResult = { ok: true; unlinked: boolean } | { ok: false; error: string };

/** "https://dev.azure.com/Org" → "Org"; "https://org.visualstudio.com" → "org". */
export function orgName(orgUrl: string): string {
  const url = new URL(orgUrl);
  const segment = url.pathname.split("/").filter(Boolean)[0];
  if (url.hostname.toLowerCase() === "dev.azure.com" && segment) return decodeURIComponent(segment);
  return url.hostname.split(".")[0]!;
}

export function originIdFor(key: WorkItemKey): string {
  return `${key.org}/${key.project}/${key.workItemId}`;
}

/** Accepts 123, "123" or "#123". */
export function parseWorkItemId(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/^#/, "") : "";
  if (!/^\d{1,9}$/.test(text)) return null;
  const id = Number(text);
  return id > 0 ? id : null;
}

/** Only the identifier: the other task may be private to people who can see this one. */
function taskLabel(issue: Pick<Issue, "identifier" | "id">): string {
  return issue.identifier ?? issue.id;
}

/** Postgres unique violation (23505), however the host passed it on: code, cause, data or message. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown }; data?: { code?: unknown }; message?: unknown } | null;
  if (!e) return false;
  if (e.code === "23505" || e.cause?.code === "23505" || e.data?.code === "23505") return true;
  return typeof e.message === "string" && /23505|duplicate key|unique constraint/i.test(e.message);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function alreadyLinked(workItemId: number, other: Pick<Issue, "identifier" | "id">): LinkResult {
  return { ok: false, error: `ADO #${workItemId} is already linked to task ${taskLabel(other)}` };
}

export function registerLinkFeatures(deps: PluginDeps, repo: LinkRepository = sqlLinkRepository(deps.ctx)): LinkFeatures {
  const { ctx } = deps;

  async function keyFor(companyId: string, workItemId: number): Promise<WorkItemKey | null> {
    const settings = await deps.settings(companyId);
    if (!settings) return null;
    return { org: orgName(settings.orgUrl), project: settings.project, workItemId };
  }

  async function findLinkByIssue(companyId: string, issueId: string): Promise<AdoLink | null> {
    return repo.findByIssue(companyId, issueId);
  }

  async function findLinkByWorkItem(companyId: string, workItemId: number): Promise<AdoLink | null> {
    const key = await keyFor(companyId, workItemId);
    return key ? repo.findByWorkItem(companyId, key) : null;
  }

  const onWorkItemChanged: WorkItemChangedHandler = async (companyId, item: WorkItemSummary, source) => {
    const key = await keyFor(companyId, item.id);
    if (!key) return;
    const updated = await repo.refresh(
      companyId,
      key,
      { type: item.type, state: item.state, title: item.title, url: item.webUrl, rev: item.rev },
      new Date(deps.now()).toISOString(),
    );
    if (updated > 0) ctx.logger.info("ADO link refreshed", { companyId, source, workItemId: item.id, state: item.state, rev: item.rev });
  };

  async function onWorkItemMissing(companyId: string, workItemId: number, source: string): Promise<void> {
    const key = await keyFor(companyId, workItemId);
    if (!key) return;
    const marked = await repo.markMissing(companyId, key, new Date(deps.now()).toISOString());
    if (marked > 0) ctx.logger.warn("Linked ADO work item not found; link marked as missing", { companyId, source, workItemId });
  }

  async function findTaskForWorkItem(companyId: string, workItemId: number): Promise<Issue | null> {
    const key = await keyFor(companyId, workItemId);
    if (!key) return null;
    const byOrigin = await ctx.issues.list({ companyId, originKind: ADO_LINK_ORIGIN_KIND, originId: originIdFor(key) });
    if (byOrigin.length > 0) {
      // Nothing in core enforces one task per origin; prefer the one the link row names.
      const row = await repo.findByWorkItem(companyId, key);
      return byOrigin.find((i) => i.id === row?.issueId) ?? byOrigin[0]!;
    }
    const row = await repo.findByWorkItem(companyId, key);
    return row ? ctx.issues.get(row.issueId, companyId) : null;
  }

  async function listLinkedTasks(companyId: string): Promise<Map<number, Issue>> {
    const settings = await deps.settings(companyId);
    const out = new Map<number, Issue>();
    if (!settings) return out;
    const prefix = `${orgName(settings.orgUrl)}/${settings.project}/`;
    for (const issue of await ctx.issues.list({ companyId, originKind: ADO_LINK_ORIGIN_KIND })) {
      if (!issue.originId?.startsWith(prefix)) continue;
      const id = parseWorkItemId(issue.originId.slice(prefix.length));
      if (id !== null && !out.has(id)) out.set(id, issue);
    }
    return out;
  }

  async function originFor(companyId: string, workItemId: number) {
    const key = await keyFor(companyId, workItemId);
    return key ? { originKind: ADO_LINK_ORIGIN_KIND, originId: originIdFor(key) } : null;
  }

  async function attachCreatedTask(
    companyId: string,
    issueId: string,
    item: WorkItemSummary,
  ): Promise<{ ok: true } | { ok: false; winnerIssueId: string }> {
    const key = await keyFor(companyId, item.id);
    if (!key) throw new Error("The Azure DevOps plugin is not configured for this company");
    const record: AdoLink = {
      issueId,
      ...key,
      type: item.type,
      state: item.state,
      title: item.title,
      url: item.webUrl,
      rev: item.rev,
      syncedAt: new Date(deps.now()).toISOString(),
      missingAt: null,
    };
    try {
      await repo.insert(companyId, record);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = await repo.findByWorkItem(companyId, key);
      if (winner && winner.issueId !== issueId) return { ok: false, winnerIssueId: winner.issueId };
      throw err;
    }
    ctx.logger.info("Task created for ADO work item", { companyId, issueId, workItemId: item.id });
    return { ok: true };
  }

  async function link(companyId: string, issueId: string, workItemId: number, actorUserId: string | null): Promise<LinkResult> {
    const key = await keyFor(companyId, workItemId);
    if (!key) return { ok: false, error: "The Azure DevOps plugin is not configured for this company" };
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) return { ok: false, error: "Task not found" };

    const originId = originIdFor(key);
    const existing = await repo.findByIssue(companyId, issueId);
    if (existing && existing.workItemId !== workItemId) {
      return { ok: false, error: `This task is already linked to ADO #${existing.workItemId}; unlink it first` };
    }
    const alreadyLinkedHere = issue.originKind === ADO_LINK_ORIGIN_KIND && issue.originId === originId;
    if (!alreadyLinkedHere && issue.originKind !== PLAIN_TASK_ORIGIN_KIND) {
      // Overwriting another origin (a routine run, a recovery task, another plugin) would break what owns it.
      return { ok: false, error: `Only ordinary tasks can be linked; this task's origin is "${issue.originKind}"` };
    }

    // Nothing in core enforces one task per origin, so check both records before linking.
    const others = (await ctx.issues.list({ companyId, originKind: ADO_LINK_ORIGIN_KIND, originId })).filter((i) => i.id !== issueId);
    if (others.length > 0) return alreadyLinked(workItemId, others[0]!);
    const linkedElsewhere = async (): Promise<LinkResult | null> => {
      const byItem = await repo.findByWorkItem(companyId, key);
      if (!byItem || byItem.issueId === issueId) return null;
      return alreadyLinked(workItemId, (await ctx.issues.get(byItem.issueId, companyId)) ?? { id: byItem.issueId, identifier: null });
    };
    const taken = await linkedElsewhere();
    if (taken) return taken;

    let item: WorkItemSummary;
    try {
      item = await (await deps.adoClient(companyId)).getWorkItemSummary(workItemId);
    } catch (err) {
      if (err instanceof AdoError && err.status === 404) {
        return { ok: false, error: `ADO #${workItemId} was not found in project ${key.project}` };
      }
      throw err;
    }

    const fields = { type: item.type, state: item.state, title: item.title, url: item.webUrl, rev: item.rev };
    const linkRecord: AdoLink = { issueId, ...key, ...fields, syncedAt: new Date(deps.now()).toISOString(), missingAt: null };
    if (existing) {
      await repo.refresh(companyId, key, fields, linkRecord.syncedAt);
    } else {
      try {
        await repo.insert(companyId, linkRecord);
      } catch (err) {
        // Another link of the same item won the race between our check and this insert.
        if (isUniqueViolation(err)) {
          const raced = await linkedElsewhere();
          if (raced) return raced;
        }
        throw err;
      }
    }
    if (!alreadyLinkedHere) {
      try {
        await ctx.issues.update(issueId, { originKind: ADO_LINK_ORIGIN_KIND, originId }, companyId, { actorUserId });
      } catch (err) {
        // Keep the two records consistent: no row without the task's origin.
        if (!existing) await repo.remove(companyId, issueId).catch(() => {});
        throw err;
      }
    }
    ctx.logger.info("Task linked to ADO work item", { companyId, issueId, workItemId });
    return { ok: true, link: (await repo.findByIssue(companyId, issueId)) ?? linkRecord };
  }

  async function unlink(companyId: string, issueId: string, actorUserId: string | null): Promise<UnlinkResult> {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) return { ok: false, error: "Task not found" };
    let unlinked = false;
    if (issue.originKind === ADO_LINK_ORIGIN_KIND) {
      // The host lets a plugin hand its own origin back to "manual" (fork patch in plugin-host-services.ts).
      await ctx.issues.update(issueId, { originKind: PLAIN_TASK_ORIGIN_KIND as never, originId: null }, companyId, { actorUserId });
      unlinked = true;
    }
    if ((await repo.remove(companyId, issueId)) > 0) unlinked = true;
    if (unlinked) ctx.logger.info("Task unlinked from ADO work item", { companyId, issueId });
    return { ok: true, unlinked };
  }

  function companyIdFrom(params: Record<string, unknown>, hostCompanyId?: string | null): string {
    const id = hostCompanyId || params.companyId;
    if (typeof id !== "string" || !id) throw new Error("companyId is required");
    return id;
  }

  function issueIdFrom(params: Record<string, unknown>): string {
    const id = params.issueId;
    if (typeof id !== "string" || !id) throw new Error("issueId is required");
    return id;
  }

  ctx.data.register(LINK_DATA_KEYS.issueLink, async (params): Promise<IssueLinkData> => {
    const companyId = companyIdFrom(params);
    const issueId = issueIdFrom(params);
    return { configured: (await deps.settings(companyId)) !== null, link: await findLinkByIssue(companyId, issueId) };
  });

  ctx.actions.register(LINK_ACTION_KEYS.link, async (params, context): Promise<LinkResult> => {
    const companyId = companyIdFrom(params, context?.companyId);
    const issueId = issueIdFrom(params);
    const workItemId = parseWorkItemId(params.workItemId);
    if (workItemId === null) return { ok: false, error: "Enter a work item ID, for example 123" };
    try {
      const result = await link(companyId, issueId, workItemId, context?.actor?.userId ?? null);
      if (result.ok) notifyBacklogChanged(ctx, companyId, { reason: "link", workItemId });
      return result;
    } catch (err) {
      ctx.logger.error("Linking a task to ADO failed", { companyId, issueId, workItemId, error: errorText(err) });
      return { ok: false, error: `Linking failed: ${errorText(err)}` };
    }
  });

  ctx.actions.register(LINK_ACTION_KEYS.unlink, async (params, context): Promise<UnlinkResult> => {
    const companyId = companyIdFrom(params, context?.companyId);
    const issueId = issueIdFrom(params);
    try {
      const result = await unlink(companyId, issueId, context?.actor?.userId ?? null);
      if (result.ok) notifyBacklogChanged(ctx, companyId, { reason: "link" });
      return result;
    } catch (err) {
      ctx.logger.error("Unlinking a task from ADO failed", { companyId, issueId, error: errorText(err) });
      return { ok: false, error: `Unlinking failed: ${errorText(err)}` };
    }
  });

  return { findLinkByIssue, findLinkByWorkItem, onWorkItemChanged, onWorkItemMissing, findTaskForWorkItem, listLinkedTasks, originFor, attachCreatedTask };
}
