/**
 * Thin Azure DevOps REST client. Plain REST rather than the ADO MCP server:
 * code-driven sync needs exact control over revisions, retries and throttling.
 * See doc/plans/2026-11-14-ado-integration.md.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const ADO_API_VERSION = "7.1";

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

export class AdoError extends Error {
  constructor(
    message: string,
    readonly status: number,
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

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.base}${path}`;
    const headers = { Accept: "application/json", Authorization: this.auth, ...(init.headers as Record<string, string>) };
    for (let attempt = 0; ; attempt++) {
      const res = await this.opts.fetch(url, { ...init, headers });
      // All agents share one PAT, so they share one ADO rate-limit budget. Honour Retry-After once.
      if ((res.status === 429 || res.status === 503) && attempt === 0) {
        await this.sleep(retryAfterMs(res.headers.get("Retry-After")));
        continue;
      }
      if (!res.ok) {
        // Never echo the request headers: they carry the PAT.
        const body = (await res.text().catch(() => "")).slice(0, 300);
        throw new AdoError(`ADO ${init.method ?? "GET"} ${path} failed with ${res.status}: ${body}`, res.status);
      }
      return (await res.json()) as T;
    }
  }
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
