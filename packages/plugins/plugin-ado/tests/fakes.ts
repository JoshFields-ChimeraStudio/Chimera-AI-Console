/**
 * In-memory stand-ins for the plugin's tables, with the same constraints and
 * semantics as the SQL implementations (the test harness has no database).
 */
import type { AdoLink } from "../src/links/index.js";
import type { LinkRepository, WorkItemKey } from "../src/links/repository.js";
import type { CachedWorkItem, ProjectKey, WorkItemCacheRepository } from "../src/backlog/repository.js";

/** In-memory stand-in for the ado_links table, with the same constraints. */
export function fakeLinkRepository(): LinkRepository & { rows: Map<string, AdoLink & { companyId: string }> } {
  const rows = new Map<string, AdoLink & { companyId: string }>();
  const same = (r: AdoLink & { companyId: string }, companyId: string, k: WorkItemKey) =>
    r.companyId === companyId && r.org === k.org && r.project === k.project && r.workItemId === k.workItemId;
  return {
    rows,
    async findByIssue(companyId, issueId) {
      const r = rows.get(issueId);
      return r && r.companyId === companyId ? { ...r } : null;
    },
    async findByWorkItem(companyId, key) {
      const r = [...rows.values()].find((x) => same(x, companyId, key));
      return r ? { ...r } : null;
    },
    async insert(companyId, link) {
      if (rows.has(link.issueId)) throw new Error("duplicate key ado_links_pkey");
      if ([...rows.values()].some((x) => same(x, companyId, link))) throw new Error("duplicate key ado_links_company_id_org_project_work_item_id_key");
      rows.set(link.issueId, { ...link, missingAt: null, companyId });
    },
    async refresh(companyId, key, data, syncedAt) {
      let n = 0;
      for (const r of rows.values()) {
        if (same(r, companyId, key) && r.rev <= data.rev) {
          Object.assign(r, data, { syncedAt, missingAt: null });
          n++;
        }
      }
      return n;
    },
    async markMissing(companyId, key, at) {
      let n = 0;
      for (const r of rows.values()) {
        if (same(r, companyId, key) && !r.missingAt) {
          r.missingAt = at;
          n++;
        }
      }
      return n;
    },
    async remove(companyId, issueId) {
      const r = rows.get(issueId);
      if (!r || r.companyId !== companyId) return 0;
      rows.delete(issueId);
      return 1;
    },
  };
}

/** In-memory stand-in for the ado_work_items table. */
export function fakeWorkItemCacheRepository(): WorkItemCacheRepository & { rows: Map<string, CachedWorkItem & { companyId: string } & ProjectKey> } {
  const rows = new Map<string, CachedWorkItem & { companyId: string } & ProjectKey>();
  const k = (companyId: string, key: ProjectKey, id: number) => `${companyId}\u0000${key.org}\u0000${key.project}\u0000${id}`;
  const inScope = (r: { companyId: string } & ProjectKey, companyId: string, key: ProjectKey) =>
    r.companyId === companyId && r.org === key.org && r.project === key.project;
  return {
    rows,
    async upsert(companyId, key, item) {
      const id = k(companyId, key, item.id);
      const existing = rows.get(id);
      if (existing && existing.rev > item.rev) return 0;
      const next = { ...item, companyId, ...key };
      if (existing && next.typeColor === null && existing.type === next.type) next.typeColor = existing.typeColor;
      if (existing && next.stateCategory === null && existing.type === next.type && existing.state === next.state) {
        next.stateCategory = existing.stateCategory;
      }
      rows.set(id, next);
      return 1;
    },
    async list(companyId, key) {
      return [...rows.values()].filter((r) => inScope(r, companyId, key)).map(strip);
    },
    async getMany(companyId, key, ids) {
      const wanted = new Set(ids);
      return [...rows.values()].filter((r) => inScope(r, companyId, key) && wanted.has(r.id)).map(strip);
    },
    async remove(companyId, key, id) {
      return rows.delete(k(companyId, key, id)) ? 1 : 0;
    },
    async listSyncedBefore(companyId, key, before) {
      return [...rows.values()].filter((r) => inScope(r, companyId, key) && Date.parse(r.syncedAt) < Date.parse(before)).map((r) => r.id);
    },
    async removeIfSyncedBefore(companyId, key, id, before) {
      const r = rows.get(k(companyId, key, id));
      if (!r || Date.parse(r.syncedAt) >= Date.parse(before)) return 0;
      rows.delete(k(companyId, key, id));
      return 1;
    },
  };
}

function strip(r: CachedWorkItem & { companyId: string } & ProjectKey): CachedWorkItem {
  const { companyId: _c, org: _o, project: _p, ...item } = r;
  return { ...item };
}
