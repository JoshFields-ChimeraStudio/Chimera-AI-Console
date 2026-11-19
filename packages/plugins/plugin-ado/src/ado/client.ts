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
  /** System.Parent: the hierarchy parent, if any. */
  parentId: number | null;
  /** Microsoft.VSTS.Common.StackRank: the backlog order (lower comes first). */
  stackRank: number | null;
}

export interface AdoComment {
  id: number;
  /** HTML, as ADO stores it, unless `format` is "markdown". */
  text: string;
  /** "html" or "markdown" (comments API 7.1-preview.4); "html" when ADO does not say. */
  format: string;
  /** ADO's own HTML rendering of the comment, when it returned one. */
  renderedText: string | null;
  createdBy: string;
  createdDate: string;
}

/** One revision of a work item, from the updates API: who made it and the fields it changed. */
export interface AdoWorkItemUpdate {
  rev: number;
  /** Display name of whoever made the revision (the service account for every agent). */
  revisedBy: string;
  revisedDate: string | null;
  fields: Record<string, { oldValue?: unknown; newValue?: unknown }>;
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
  /** Repository name, when ADO returned it. */
  repositoryName: string;
  /** Branch names without "refs/heads/", or null when ADO did not return them. */
  sourceBranch: string | null;
  targetBranch: string | null;
}

/** One comment of a pull request thread. */
export interface AdoPullRequestComment {
  threadId: number;
  commentId: number;
  author: string;
  content: string;
  /** "text" for people; "system" for ADO's own notes (votes, pushes, policy). */
  commentType: string;
  publishedDate: string | null;
  /** File and line of the thread, for comments on code. */
  filePath: string | null;
  line: number | null;
}

/** A pull request thread with its live comments. */
export interface AdoPullRequestThread {
  id: number;
  /** active, fixed, wontFix, closed, byDesign, pending, or unknown. */
  status: string;
  filePath: string | null;
  line: number | null;
  comments: Array<{ id: number; author: string; content: string; commentType: string; publishedDate: string | null }>;
}

/** Thread states ADO accepts when creating or updating a pull request thread. */
export const PR_THREAD_STATUSES = ["active", "fixed", "wontFix", "closed", "byDesign", "pending"] as const;
export type PrThreadStatus = (typeof PR_THREAD_STATUSES)[number];

/** A work item type as the project's process defines it. */
export interface AdoWorkItemType {
  name: string;
  /** Hex colour with a leading "#", or null. */
  color: string | null;
  /** The type's states, if ADO returned them with the type list. */
  states: AdoWorkItemState[] | null;
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

const SUMMARY_FIELDS = [
  "System.Id",
  "System.WorkItemType",
  "System.State",
  "System.Title",
  "System.ChangedBy",
  "System.ChangedDate",
  "System.Parent",
  "Microsoft.VSTS.Common.StackRank",
];

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

  /** The most recent comments on a work item, newest first (ADO returns at most 200 per call). */
  async listComments(id: number, top = 5): Promise<{ comments: AdoComment[]; totalCount: number }> {
    const res = await this.request<{ comments?: Array<Record<string, any>>; totalCount?: number }>(
      `/_apis/wit/workItems/${id}/comments?$top=${top}&order=desc&$expand=renderedText&api-version=${ADO_COMMENTS_API_VERSION}`,
    );
    const comments = (res.comments ?? []).filter((c) => !c.isDeleted).map((c) => ({
      id: Number(c.id),
      text: String(c.text ?? ""),
      format: typeof c.format === "string" ? c.format.toLowerCase() : "html",
      renderedText: typeof c.renderedText === "string" ? c.renderedText : null,
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
    return { id: Number(c.id), text: String(c.text ?? ""), format: "html", renderedText: null, createdBy: String(c.createdBy?.displayName ?? ""), createdDate: String(c.createdDate ?? "") };
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

  /** A work item's whole history, oldest first (the updates API, paged 200 at a time). */
  async listUpdates(id: number): Promise<AdoWorkItemUpdate[]> {
    const out: AdoWorkItemUpdate[] = [];
    const PAGE = 200;
    for (let skip = 0; ; skip += PAGE) {
      const res = await this.request<{
        value?: Array<{
          rev?: number;
          revisedBy?: { displayName?: string; uniqueName?: string };
          revisedDate?: string;
          fields?: Record<string, { oldValue?: unknown; newValue?: unknown }>;
        }>;
      }>(`/_apis/wit/workItems/${id}/updates?$top=${PAGE}&$skip=${skip}&api-version=${ADO_API_VERSION}`);
      const page = res.value ?? [];
      for (const u of page) {
        out.push({
          rev: Number(u.rev ?? 0),
          revisedBy: String(u.revisedBy?.displayName ?? u.revisedBy?.uniqueName ?? ""),
          // ADO puts 9999-01-01 on the current revision's "revised" date.
          revisedDate: u.revisedDate && !u.revisedDate.startsWith("9999") ? u.revisedDate : null,
          fields: u.fields ?? {},
        });
      }
      if (page.length < PAGE) return out;
    }
  }

  /** The state changes in a work item's history, oldest first. Each entry is one revision that changed System.State. */
  async listStateChanges(id: number): Promise<Array<{ rev: number; from: string | null; to: string }>> {
    const out: Array<{ rev: number; from: string | null; to: string }> = [];
    for (const u of await this.listUpdates(id)) {
      const state = u.fields["System.State"];
      if (state && typeof state.newValue === "string") {
        out.push({ rev: u.rev, from: typeof state.oldValue === "string" ? state.oldValue : null, to: state.newValue });
      }
    }
    return out;
  }

  /** The states a work item type can be in, in the project's process. */
  async getWorkItemTypeStates(type: string): Promise<AdoWorkItemState[]> {
    const res = await this.request<{ value: Array<{ name: string; category?: string }> }>(
      `/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states?api-version=${ADO_API_VERSION}`,
    );
    return res.value.map((s) => ({ name: s.name, category: s.category ?? "" }));
  }

  /** All work item types of the project, with their colours and (usually) their states. */
  async listWorkItemTypes(): Promise<AdoWorkItemType[]> {
    const res = await this.request<{ value: Array<{ name: string; color?: string; states?: Array<{ name: string; category?: string }> }> }>(
      `/_apis/wit/workitemtypes?api-version=${ADO_API_VERSION}`,
    );
    return res.value.map((t) => ({
      name: t.name,
      color: normalizeColor(t.color),
      states: Array.isArray(t.states) ? t.states.map((st) => ({ name: st.name, category: st.category ?? "" })) : null,
    }));
  }

  /** A Git repository in the project, by name or id. */
  async getRepository(nameOrId: string): Promise<AdoRepository> {
    const r = await this.request<{ id: string; name: string; project?: { id?: string } }>(
      `/_apis/git/repositories/${encodeURIComponent(nameOrId)}?api-version=${ADO_API_VERSION}`,
    );
    return { id: r.id, name: r.name, projectId: String(r.project?.id ?? "") };
  }

  /** A pull request; without a repository it is looked up in the whole project. */
  async getPullRequest(repositoryId: string | null, pullRequestId: number): Promise<AdoPullRequest> {
    const path = repositoryId
      ? `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}`
      : `/_apis/git/pullrequests/${pullRequestId}`;
    const pr = await this.request<{
      pullRequestId: number;
      title?: string;
      status?: string;
      sourceRefName?: string;
      targetRefName?: string;
      repository?: { id?: string; name?: string };
    }>(`${path}?api-version=${ADO_API_VERSION}`);
    return {
      pullRequestId: pr.pullRequestId,
      title: String(pr.title ?? ""),
      status: String(pr.status ?? ""),
      repositoryId: String(pr.repository?.id ?? repositoryId ?? ""),
      repositoryName: String(pr.repository?.name ?? ""),
      sourceBranch: branchName(pr.sourceRefName),
      targetBranch: branchName(pr.targetRefName),
    };
  }

  /** IDs of the work items linked to a pull request. */
  async listPullRequestWorkItemIds(repositoryId: string, pullRequestId: number): Promise<number[]> {
    const res = await this.request<{ value?: Array<{ id?: unknown }> }>(
      `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequestId}/workitems?api-version=${ADO_API_VERSION}`,
    );
    return (res.value ?? []).map((w) => positiveIntOrNull(w.id)).filter((id): id is number => id !== null);
  }

  /** Every live comment of every live thread of a pull request. */
  async listPullRequestComments(repositoryId: string, pullRequestId: number): Promise<AdoPullRequestComment[]> {
    const res = await this.request<{
      value?: Array<{
        id: number;
        isDeleted?: boolean;
        threadContext?: { filePath?: string; rightFileStart?: { line?: number }; leftFileStart?: { line?: number } } | null;
        comments?: Array<{
          id: number;
          isDeleted?: boolean;
          content?: string;
          commentType?: string;
          publishedDate?: string;
          author?: { displayName?: string; uniqueName?: string };
        }>;
      }>;
    }>(`/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequestId}/threads?api-version=${ADO_API_VERSION}`);
    const out: AdoPullRequestComment[] = [];
    for (const t of res.value ?? []) {
      if (t.isDeleted) continue;
      const ctx = t.threadContext ?? null;
      for (const c of t.comments ?? []) {
        if (c.isDeleted) continue;
        out.push({
          threadId: t.id,
          commentId: c.id,
          author: String(c.author?.displayName ?? c.author?.uniqueName ?? ""),
          content: String(c.content ?? ""),
          commentType: String(c.commentType ?? "text"),
          publishedDate: c.publishedDate ?? null,
          filePath: ctx?.filePath ?? null,
          line: positiveIntOrNull(ctx?.rightFileStart?.line ?? ctx?.leftFileStart?.line),
        });
      }
    }
    return out;
  }

  /** The active pull request from one branch into another, if there is one. */
  async findActivePullRequest(repositoryId: string, sourceBranch: string, targetBranch: string): Promise<AdoPullRequest | null> {
    const q = new URLSearchParams({
      "searchCriteria.sourceRefName": `refs/heads/${sourceBranch}`,
      "searchCriteria.targetRefName": `refs/heads/${targetBranch}`,
      "searchCriteria.status": "active",
      "api-version": ADO_API_VERSION,
    });
    const res = await this.request<{ value?: Array<{ pullRequestId: number }> }>(
      `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests?${q.toString()}`,
    );
    const first = res.value?.[0];
    return first ? this.getPullRequest(repositoryId, first.pullRequestId) : null;
  }

  /** Open a pull request, linked to the given work items. */
  async createPullRequest(
    repositoryId: string,
    input: { sourceBranch: string; targetBranch: string; title: string; description: string; workItemIds: number[] },
  ): Promise<AdoPullRequest> {
    const created = await this.request<{ pullRequestId: number }>(
      `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests?api-version=${ADO_API_VERSION}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceRefName: `refs/heads/${input.sourceBranch}`,
          targetRefName: `refs/heads/${input.targetBranch}`,
          title: input.title,
          description: input.description,
          workItemRefs: input.workItemIds.map((id) => ({ id: String(id) })),
        }),
      },
      { idempotent: false },
    );
    return this.getPullRequest(repositoryId, created.pullRequestId);
  }

  /** The live threads of a pull request, with their live comments, oldest first. */
  async listPullRequestThreads(repositoryId: string, pullRequestId: number): Promise<AdoPullRequestThread[]> {
    const res = await this.request<{
      value?: Array<{
        id: number;
        status?: string;
        isDeleted?: boolean;
        threadContext?: { filePath?: string; rightFileStart?: { line?: number }; leftFileStart?: { line?: number } } | null;
        comments?: Array<{
          id: number;
          isDeleted?: boolean;
          content?: string;
          commentType?: string;
          publishedDate?: string;
          author?: { displayName?: string; uniqueName?: string };
        }>;
      }>;
    }>(`/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequestId}/threads?api-version=${ADO_API_VERSION}`);
    return (res.value ?? [])
      .filter((t) => !t.isDeleted)
      .map((t) => ({
        id: t.id,
        status: String(t.status ?? "unknown"),
        filePath: t.threadContext?.filePath ?? null,
        line: positiveIntOrNull(t.threadContext?.rightFileStart?.line ?? t.threadContext?.leftFileStart?.line),
        comments: (t.comments ?? [])
          .filter((c) => !c.isDeleted)
          .map((c) => ({
            id: c.id,
            author: String(c.author?.displayName ?? c.author?.uniqueName ?? ""),
            content: String(c.content ?? ""),
            commentType: String(c.commentType ?? "text"),
            publishedDate: c.publishedDate ?? null,
          })),
      }));
  }

  /** Start a thread on a pull request, optionally on a file and line. */
  async createPullRequestThread(
    repositoryId: string,
    pullRequestId: number,
    input: { content: string; status: PrThreadStatus; filePath?: string | null; line?: number | null },
  ): Promise<{ threadId: number; commentId: number }> {
    const filePath = input.filePath ? (input.filePath.startsWith("/") ? input.filePath : `/${input.filePath}`) : null;
    const body: Record<string, unknown> = {
      comments: [{ parentCommentId: 0, content: input.content, commentType: 1 }],
      status: input.status,
    };
    if (filePath) {
      const line = input.line ?? 1;
      body.threadContext = { filePath, rightFileStart: { line, offset: 1 }, rightFileEnd: { line, offset: 1 } };
    }
    const t = await this.request<{ id: number; comments?: Array<{ id: number }> }>(
      `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequestId}/threads?api-version=${ADO_API_VERSION}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      { idempotent: false },
    );
    return { threadId: t.id, commentId: t.comments?.[0]?.id ?? 1 };
  }

  /** Reply on a pull request thread. */
  async addPullRequestThreadComment(repositoryId: string, pullRequestId: number, threadId: number, content: string): Promise<{ commentId: number }> {
    const c = await this.request<{ id: number }>(
      `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequestId}/threads/${threadId}/comments?api-version=${ADO_API_VERSION}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, parentCommentId: 1, commentType: 1 }) },
      { idempotent: false },
    );
    return { commentId: c.id };
  }

  /** Set a pull request thread's status, for example fixed or closed. */
  async updatePullRequestThreadStatus(repositoryId: string, pullRequestId: number, threadId: number, status: PrThreadStatus): Promise<void> {
    await this.request<unknown>(
      `/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequestId}/threads/${threadId}?api-version=${ADO_API_VERSION}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) },
    );
  }

  /** Browser link for a pull request; `repository` may be the repository's name or id. */
  pullRequestWebUrl(repository: string, pullRequestId: number): string {
    return `${this.base}/_git/${encodeURIComponent(repository)}/pullrequest/${pullRequestId}`;
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
    parentId: positiveIntOrNull(f["System.Parent"]),
    stackRank: finiteOrNull(f["Microsoft.VSTS.Common.StackRank"]),
  };
}

function branchName(ref: unknown): string | null {
  return typeof ref === "string" && ref ? ref.replace(/^refs\/heads\//, "") : null;
}

function positiveIntOrNull(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

function finiteOrNull(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** ADO gives type colours as "FF7B00" (sometimes with alpha, "FFFF7B00"); the console wants "#FF7B00". */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex.toUpperCase()}`;
  if (/^[0-9a-f]{8}$/i.test(hex)) return `#${hex.slice(2).toUpperCase()}`;
  return null;
}
