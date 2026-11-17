/**
 * Thin Azure DevOps REST client. Plain REST rather than the ADO MCP server:
 * code-driven sync needs exact control over revisions, retries and throttling.
 * See doc/plans/2026-11-14-ado-integration.md.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const ADO_API_VERSION = "7.1";
/** The work item comments API is still a preview API in 7.1. */
export const ADO_COMMENTS_API_VERSION = "7.1-preview.4";

export interface AdoWorkItem {
  id: number;
  rev: number;
  url: string;
  fields: Record<string, unknown>;
  relations?: Array<{ rel: string; url: string; attributes?: Record<string, unknown> }>;
}

/** The fields the plugin cares about, flattened. Shared with A2 (links) and A4 (state sync). */
export interface WorkItemSummary {
  id: number;
  rev: number;
  type: string;
  state: string;
  title: string;
  changedBy: string | null;
  /** ISO timestamp of the last change, or null if ADO did not return it. */
  changedDate: string | null;
  webUrl: string;
}

export interface AdoComment {
  id: number;
  /** HTML, as ADO stores it. */
  text: string;
  createdBy: string;
  createdDate: string;
}

/** One JSON Patch operation, as the work item update and create APIs take them. */
export interface JsonPatchOp {
  op: "add" | "replace" | "remove" | "test";
  path: string;
  value?: unknown;
}

export interface AdoWorkItemState {
  name: string;
  /** Proposed, InProgress, Resolved, Completed or Removed. */
  category: string;
}

export interface AdoRepository {
  id: string;
  name: string;
  projectId: string;
}

export interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  status: string;
  repositoryId: string;
}

export class AdoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** ADO's error text, without the request. Safe to show to an agent. */
    readonly detail = "",
  ) {
    super(message);
    this.name = "AdoError";
  }
}

export interface AdoClientOptions {
  orgUrl: string;
  project: string;
  pat: string;
  fetch: FetchFn;
  /** Wait used for Retry-After; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRY_AFTER_MS = 30_000;

const SUMMARY_FIELDS = ["System.Id", "System.WorkItemType", "System.State", "System.Title", "System.ChangedBy", "System.ChangedDate"];

export class AdoClient {
  private readonly base: string;
  private readonly auth: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: AdoClientOptions) {
    this.base = `${opts.orgUrl.replace(/\/+$/, "")}/${encodeURIComponent(opts.project)}`;
    this.auth = `Basic ${Buffer.from(`:${opts.pat}`).toString("base64")}`;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Browser link for a work item. */
  webUrl(id: number): string {
    return `${this.base}/_workitems/edit/${id}`;
  }

  async getWorkItem(id: number): Promise<AdoWorkItem> {
    return this.request<AdoWorkItem>(`/_apis/wit/workitems/${id}?$expand=relations&api-version=${ADO_API_VERSION}`);
  }

  async getWorkItemSummary(id: number): Promise<WorkItemSummary> {
    return summarize(await this.getWorkItem(id), this.webUrl(id));
  }

  /**
   * IDs of work items in the project changed after `since`, oldest first, at most `top`.
   * WIQL refuses result sets over 20,000 items, so callers page through by date.
   */
  async queryChangedSince(since: Date, top = 5000, asOf?: Date): Promise<number[]> {
    // WIQL compares dates by day unless timePrecision=true. ASOF freezes the data at one moment.
    const iso = since.toISOString();
    const query =
      `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ` +
      `AND [System.ChangedDate] > '${iso}' ORDER BY [System.ChangedDate] ASC` +
      (asOf ? ` ASOF '${asOf.toISOString()}'` : "");
    const res = await this.request<{ workItems: Array<{ id: number }> }>(
      `/_apis/wit/wiql?timePrecision=true&$top=${top}&api-version=${ADO_API_VERSION}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) },
    );
    return res.workItems.map((w) => w.id);
  }

  /** Summaries for many work items, 200 per request (the API maximum), optionally as they were at `asOf`. */
  async getWorkItemSummaries(ids: number[], asOf?: Date): Promise<WorkItemSummary[]> {
    const out: WorkItemSummary[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const res = await this.request<{ value: AdoWorkItem[] }>(`/_apis/wit/workitemsbatch?api-version=${ADO_API_VERSION}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: chunk, fields: SUMMARY_FIELDS, errorPolicy: "omit", ...(asOf ? { asOf: asOf.toISOString() } : {}) }),
      });
      // errorPolicy=omit returns null for items that were deleted or are not visible.
      for (const item of res.value) if (item) out.push(summarize(item, this.webUrl(item.id)));
    }
    return out;
  }

  /** The most recent comments on a work item, newest first. */
  async listComments(id: number, top = 5): Promise<{ comments: AdoComment[]; totalCount: number }> {
    const res = await this.request<{ comments?: Array<Record<string, any>>; totalCount?: number }>(
      `/_apis/wit/workItems/${id}/comments?$top=${top}&order=desc&api-version=${ADO_COMMENTS_API_VERSION}`,
    );
    const comments = (res.comments ?? []).map((c) => ({
      id: Number(c.id),
      text: String(c.text ?? ""),
      createdBy: String(c.createdBy?.displayName ?? ""),
      createdDate: String(c.createdDate ?? ""),
    }));
    return { comments, totalCount: res.totalCount ?? comments.length };
  }

  /** Adds a comment. `html` must already be safe HTML. */
  async addComment(id: number, html: string): Promise<AdoComment> {
    const c = await this.request<Record<string, any>>(
      `/_apis/wit/workItems/${id}/comments?api-version=${ADO_COMMENTS_API_VERSION}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: html }) },
      { idempotent: false },
    );
    return { id: Number(c.id), text: String(c.text ?? ""), createdBy: String(c.createdBy?.displayName ?? ""), createdDate: String(c.createdDate ?? "") };
  }

  /**
   * Applies a JSON Patch to a work item. Callers start the patch with a
   * `test /rev` operation so a concurrent edit fails instead of being overwritten.
   */
  async updateWorkItem(id: number, ops: JsonPatchOp[]): Promise<AdoWorkItem> {
    return this.request<AdoWorkItem>(`/_apis/wit/workitems/${id}?api-version=${ADO_API_VERSION}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json-patch+json" },
      body: JSON.stringify(ops),
    });
  }

  /** Creates a work item of `type` (for example "Task" or "User Story") from a JSON Patch. */
  async createWorkItem(type: string, ops: JsonPatchOp[]): Promise<AdoWorkItem> {
    return this.request<AdoWorkItem>(
      `/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=${ADO_API_VERSION}`,
      { method: "POST", headers: { "Content-Type": "application/json-patch+json" }, body: JSON.stringify(ops) },
      { idempotent: false },
    );
  }

  /** The states a work item type can be in, in the project's process. */
  async getWorkItemTypeStates(type: string): Promise<AdoWorkItemState[]> {
    const res = await this.request<{ value: Array<{ name: string; category?: string }> }>(
      `/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states?api-version=${ADO_API_VERSION}`,
    );
    return res.value.map((s) => ({ name: s.name, category: s.category ?? "" }));
  }

  /** A Git repository in the project, by name or id. */
  async getRepository(nameOrId: string): Promise<AdoRepository> {
    const r = await this.request<{ id: string; name: string; project?: { id?: string } }>(
      `/_apis/git/repositories/${encodeURIComponent(nameOrId)}?api-version=${ADO_API_VERSION}`,
    );
    return { id: r.id, name: r.name, projectId: String(r.project?.id ?? "") };
  }

  async getPullRequest(repositoryId: string, pullRequestId: number): Promise<AdoPullRequest> {
    const pr = await this.request<{ pullRequestId: number; title?: string; status?: string; repository?: { id?: string } }>(
      `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}?api-version=${ADO_API_VERSION}`,
    );
    return { pullRequestId: pr.pullRequestId, title: String(pr.title ?? ""), status: String(pr.status ?? ""), repositoryId: String(pr.repository?.id ?? repositoryId) };
  }

  /** The API URL ADO uses to name a work item in relations (for example a parent link). */
  workItemApiUrl(id: number): string {
    return `${this.opts.orgUrl.replace(/\/+$/, "")}/_apis/wit/workItems/${id}`;
  }

  /**
   * `idempotent: false` marks a call that must not run twice (adding a comment,
   * creating an item). Those are retried only on a 429 that carries Retry-After,
   * where ADO has refused the request without doing it; never on a 503, where
   * the first attempt may have gone through. Reads, read-only POSTs (WIQL,
   * batch) and rev-guarded PATCHes are safe to retry.
   */
  private async request<T>(path: string, init: RequestInit = {}, opts: { idempotent?: boolean } = {}): Promise<T> {
    const idempotent = opts.idempotent ?? true;
    const url = `${this.base}${path}`;
    const headers = { Accept: "application/json", Authorization: this.auth, ...(init.headers as Record<string, string>) };
    for (let attempt = 0; ; attempt++) {
      const res = await this.opts.fetch(url, { ...init, headers });
      // All agents share one PAT, so they share one ADO rate-limit budget. Honour Retry-After once.
      const retryable = idempotent
        ? res.status === 429 || res.status === 503
        : res.status === 429 && res.headers.get("Retry-After") !== null;
      if (retryable && attempt === 0) {
        await this.sleep(retryAfterMs(res.headers.get("Retry-After")));
        continue;
      }
      if (!res.ok) {
        // Never echo the request headers: they carry the PAT.
        const body = (await res.text().catch(() => "")).slice(0, 300);
        throw new AdoError(`ADO ${init.method ?? "GET"} ${path} failed with ${res.status}: ${body}`, res.status, adoErrorDetail(body));
      }
      return (await res.json()) as T;
    }
  }
}

/** ADO error bodies are JSON with a `message`; fall back to the raw text. */
function adoErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON
  }
  return body;
}

/** Retry-After may be seconds or an HTTP date. Clamped to 1-30 seconds. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  let ms = 5000;
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) ms = seconds * 1000;
    else {
      const date = Date.parse(header);
      if (Number.isFinite(date)) ms = date - now;
    }
  }
  return Math.min(Math.max(ms, 1000), MAX_RETRY_AFTER_MS);
}

export function summarize(item: AdoWorkItem, webUrl: string): WorkItemSummary {
  const f = item.fields;
  const changedBy = f["System.ChangedBy"];
  return {
    id: item.id,
    rev: item.rev,
    type: String(f["System.WorkItemType"] ?? ""),
    state: String(f["System.State"] ?? ""),
    title: String(f["System.Title"] ?? ""),
    changedBy:
      typeof changedBy === "string"
        ? changedBy
        : changedBy && typeof changedBy === "object"
          ? String((changedBy as { displayName?: string }).displayName ?? "")
          : null,
    changedDate: typeof f["System.ChangedDate"] === "string" ? (f["System.ChangedDate"] as string) : null,
    webUrl,
  };
}
