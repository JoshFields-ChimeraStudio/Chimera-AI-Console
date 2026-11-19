/**
 * The work item cache behind the Backlog view: the `ado_work_items` table in the
 * plugin's database namespace (migrations/002_ado_work_items.sql). Kept behind
 * an interface, like the link repository, because the test harness has no database.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface ProjectKey {
  org: string;
  project: string;
}

export type StateCategory = "Proposed" | "InProgress" | "Resolved" | "Completed" | "Removed";

export interface CachedWorkItem {
  id: number;
  parentId: number | null;
  type: string;
  typeColor: string | null;
  title: string;
  state: string;
  stateCategory: StateCategory | null;
  stackRank: number | null;
  url: string;
  rev: number;
  changedDate: string | null;
  syncedAt: string;
}

export interface WorkItemCacheRepository {
  /**
   * Insert or update the row, unless the cache already holds a newer revision.
   * A missing colour or state category (type lookup failed) keeps the stored one
   * while the type or state is unchanged. Returns 1 if the row was written.
   */
  upsert(companyId: string, key: ProjectKey, item: CachedWorkItem): Promise<number>;
  list(companyId: string, key: ProjectKey): Promise<CachedWorkItem[]>;
  getMany(companyId: string, key: ProjectKey, ids: number[]): Promise<CachedWorkItem[]>;
  remove(companyId: string, key: ProjectKey, id: number): Promise<number>;
  /** IDs of rows last written before `before` (see removeIfSyncedBefore). */
  listSyncedBefore(companyId: string, key: ProjectKey, before: string): Promise<number[]>;
  /**
   * Delete one row if it was last written before `before` (a full sync found the item gone;
   * a row a live event wrote meanwhile stays). Returns 1 if deleted. One statement per
   * row because ctx.db.execute returns only a row count, not the deleted rows.
   */
  removeIfSyncedBefore(companyId: string, key: ProjectKey, id: number, before: string): Promise<number>;
}

const STATE_CATEGORIES = new Set<string>(["Proposed", "InProgress", "Resolved", "Completed", "Removed"]);

export function toStateCategory(value: unknown): StateCategory | null {
  return typeof value === "string" && STATE_CATEGORIES.has(value) ? (value as StateCategory) : null;
}

interface Row {
  work_item_id: number | string;
  parent_id: number | string | null;
  work_item_type: string;
  type_color: string | null;
  title: string;
  state: string;
  state_category: string | null;
  stack_rank: number | string | null;
  url: string;
  rev: number | string;
  changed_date: string | Date | null;
  synced_at: string | Date;
}

function iso(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toItem(row: Row): CachedWorkItem {
  return {
    id: Number(row.work_item_id),
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    type: row.work_item_type,
    typeColor: row.type_color,
    title: row.title,
    state: row.state,
    stateCategory: toStateCategory(row.state_category),
    stackRank: row.stack_rank === null ? null : Number(row.stack_rank),
    url: row.url,
    rev: Number(row.rev),
    changedDate: iso(row.changed_date),
    syncedAt: iso(row.synced_at) ?? "",
  };
}

const COLUMNS =
  "work_item_id, parent_id, work_item_type, type_color, title, state, state_category, stack_rank, url, rev, changed_date, synced_at";

/** SQL implementation on ctx.db. Every statement is scoped to the company, org and project. */
export function sqlWorkItemCacheRepository(ctx: PluginContext): WorkItemCacheRepository {
  const table = () => `${ctx.db.namespace}.ado_work_items`;
  return {
    async upsert(companyId, key, item) {
      const res = await ctx.db.execute(
        `INSERT INTO ${table()} AS w (company_id, org, project, ${COLUMNS}) ` +
          `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15::timestamptz) ` +
          `ON CONFLICT (company_id, org, project, work_item_id) DO UPDATE SET ` +
          `parent_id = EXCLUDED.parent_id, work_item_type = EXCLUDED.work_item_type, ` +
          `type_color = CASE WHEN EXCLUDED.type_color IS NULL AND w.work_item_type = EXCLUDED.work_item_type THEN w.type_color ELSE EXCLUDED.type_color END, ` +
          `title = EXCLUDED.title, state = EXCLUDED.state, ` +
          `state_category = CASE WHEN EXCLUDED.state_category IS NULL AND w.work_item_type = EXCLUDED.work_item_type AND w.state = EXCLUDED.state THEN w.state_category ELSE EXCLUDED.state_category END, ` +
          `stack_rank = EXCLUDED.stack_rank, url = EXCLUDED.url, rev = EXCLUDED.rev, ` +
          `changed_date = EXCLUDED.changed_date, synced_at = EXCLUDED.synced_at ` +
          `WHERE w.rev <= EXCLUDED.rev`,
        [
          companyId,
          key.org,
          key.project,
          item.id,
          item.parentId,
          item.type,
          item.typeColor,
          item.title,
          item.state,
          item.stateCategory,
          item.stackRank,
          item.url,
          item.rev,
          item.changedDate,
          item.syncedAt,
        ],
      );
      return res.rowCount;
    },
    async list(companyId, key) {
      const rows = await ctx.db.query<Row>(
        `SELECT ${COLUMNS} FROM ${table()} WHERE company_id = $1 AND org = $2 AND project = $3`,
        [companyId, key.org, key.project],
      );
      return rows.map(toItem);
    },
    async getMany(companyId, key, ids) {
      if (ids.length === 0) return [];
      // A JSON array keeps this one parameter however many IDs there are.
      const rows = await ctx.db.query<Row>(
        `SELECT ${COLUMNS} FROM ${table()} WHERE company_id = $1 AND org = $2 AND project = $3 ` +
          `AND work_item_id IN (SELECT jsonb_array_elements_text($4::jsonb)::integer)`,
        [companyId, key.org, key.project, JSON.stringify(ids)],
      );
      return rows.map(toItem);
    },
    async remove(companyId, key, id) {
      const res = await ctx.db.execute(
        `DELETE FROM ${table()} WHERE company_id = $1 AND org = $2 AND project = $3 AND work_item_id = $4`,
        [companyId, key.org, key.project, id],
      );
      return res.rowCount;
    },
    async listSyncedBefore(companyId, key, before) {
      const rows = await ctx.db.query<{ work_item_id: number | string }>(
        `SELECT work_item_id FROM ${table()} WHERE company_id = $1 AND org = $2 AND project = $3 AND synced_at < $4::timestamptz`,
        [companyId, key.org, key.project, before],
      );
      return rows.map((r) => Number(r.work_item_id));
    },
    async removeIfSyncedBefore(companyId, key, id, before) {
      const res = await ctx.db.execute(
        `DELETE FROM ${table()} WHERE company_id = $1 AND org = $2 AND project = $3 AND work_item_id = $4 AND synced_at < $5::timestamptz`,
        [companyId, key.org, key.project, id, before],
      );
      return res.rowCount;
    },
  };
}
