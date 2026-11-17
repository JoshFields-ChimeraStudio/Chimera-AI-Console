/**
 * Storage for task-to-work-item links: the `ado_links` table in the plugin's own
 * database namespace (migrations/001_ado_links.sql). Kept behind an interface so
 * the link logic can be tested without a database (the test harness has none).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AdoLink } from "./index.js";

export interface WorkItemKey {
  org: string;
  project: string;
  workItemId: number;
}

export interface LinkRefresh {
  type: string;
  state: string;
  title: string;
  url: string;
  rev: number;
}

export interface LinkRepository {
  findByIssue(companyId: string, issueId: string): Promise<AdoLink | null>;
  findByWorkItem(companyId: string, key: WorkItemKey): Promise<AdoLink | null>;
  /** Fails if the task or the work item is already linked (primary key and unique constraint). */
  insert(companyId: string, link: AdoLink): Promise<void>;
  /** Update the stored copy unless it already holds a newer revision. Returns the number of links updated. */
  refresh(companyId: string, key: WorkItemKey, data: LinkRefresh, syncedAt: string): Promise<number>;
  /** The work item could not be found in ADO (deleted, moved or not visible). Returns the number of links marked. */
  markMissing(companyId: string, key: WorkItemKey, at: string): Promise<number>;
  remove(companyId: string, issueId: string): Promise<number>;
}

interface LinkRow {
  issue_id: string;
  org: string;
  project: string;
  work_item_id: number | string;
  work_item_type: string;
  state: string;
  title: string;
  url: string;
  rev: number | string;
  synced_at: string | Date;
  missing_at: string | Date | null;
}

function iso(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toLink(row: LinkRow): AdoLink {
  return {
    issueId: row.issue_id,
    org: row.org,
    project: row.project,
    workItemId: Number(row.work_item_id),
    type: row.work_item_type,
    state: row.state,
    title: row.title,
    url: row.url,
    rev: Number(row.rev),
    syncedAt: iso(row.synced_at) ?? "",
    missingAt: iso(row.missing_at),
  };
}

const COLUMNS = "issue_id, org, project, work_item_id, work_item_type, state, title, url, rev, synced_at, missing_at";

/** SQL implementation on ctx.db. Every statement is scoped to the company. */
export function sqlLinkRepository(ctx: PluginContext): LinkRepository {
  const table = () => `${ctx.db.namespace}.ado_links`;
  return {
    async findByIssue(companyId, issueId) {
      const rows = await ctx.db.query<LinkRow>(
        `SELECT ${COLUMNS} FROM ${table()} WHERE company_id = $1 AND issue_id = $2`,
        [companyId, issueId],
      );
      return rows[0] ? toLink(rows[0]) : null;
    },
    async findByWorkItem(companyId, key) {
      const rows = await ctx.db.query<LinkRow>(
        `SELECT ${COLUMNS} FROM ${table()} WHERE company_id = $1 AND org = $2 AND project = $3 AND work_item_id = $4`,
        [companyId, key.org, key.project, key.workItemId],
      );
      return rows[0] ? toLink(rows[0]) : null;
    },
    async insert(companyId, link) {
      await ctx.db.execute(
        `INSERT INTO ${table()} (issue_id, company_id, org, project, work_item_id, work_item_type, state, title, url, rev, synced_at) ` +
          `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
        [link.issueId, companyId, link.org, link.project, link.workItemId, link.type, link.state, link.title, link.url, link.rev, link.syncedAt],
      );
    },
    async refresh(companyId, key, data, syncedAt) {
      const res = await ctx.db.execute(
        `UPDATE ${table()} SET work_item_type = $5, state = $6, title = $7, url = $8, rev = $9, synced_at = $10::timestamptz, missing_at = NULL ` +
          `WHERE company_id = $1 AND org = $2 AND project = $3 AND work_item_id = $4 AND rev <= $9`,
        [companyId, key.org, key.project, key.workItemId, data.type, data.state, data.title, data.url, data.rev, syncedAt],
      );
      return res.rowCount;
    },
    async markMissing(companyId, key, at) {
      const res = await ctx.db.execute(
        `UPDATE ${table()} SET missing_at = $5::timestamptz ` +
          `WHERE company_id = $1 AND org = $2 AND project = $3 AND work_item_id = $4 AND missing_at IS NULL`,
        [companyId, key.org, key.project, key.workItemId, at],
      );
      return res.rowCount;
    },
    async remove(companyId, issueId) {
      const res = await ctx.db.execute(`DELETE FROM ${table()} WHERE company_id = $1 AND issue_id = $2`, [companyId, issueId]);
      return res.rowCount;
    },
  };
}
