/**
 * A5: the pull requests of a task's work item, as the task's "Pull request" tab shows them, and
 * whether a work item's code is merged (which releases the Stories that depend on it, A6).
 *
 * Read live from ADO when the tab opens: status, merge conflicts, reviewers' votes, branch policy
 * checks and the open comment threads (the reviewers' findings). A Review or QA Test has no pull
 * request of its own, so its tab shows its parent Story's.
 */
import type {
  AdoClient,
  AdoPolicyEvaluation,
  AdoPullRequest,
  AdoPullRequestReviewer,
  AdoPullRequestThread,
  AdoWorkItem,
} from "../ado/client.js";
import { pullRequestRefs } from "../backlog/index.js";
import type { PluginDeps } from "../deps.js";
import type { LinkFeatures } from "../links/index.js";

export const PR_VIEW_DATA_KEY = "task-pull-requests";

/** Types whose pull request is their parent's. */
const CHILD_OF_PR_TYPES = new Set(["review", "qa test"]);
const MAX_THREADS = 20;
const MAX_EXCERPT = 400;

export interface PullRequestReviewerView {
  name: string;
  vote: number;
  /** "Approved", "Approved with suggestions", "Waiting for author", "Rejected" or "No vote". */
  voteLabel: string;
  isRequired: boolean;
}

export interface PullRequestThreadView {
  id: number;
  status: string;
  filePath: string | null;
  line: number | null;
  author: string;
  excerpt: string;
  replies: number;
}

export interface PullRequestView {
  pullRequestId: number;
  title: string;
  url: string;
  status: string;
  isDraft: boolean;
  mergeStatus: string;
  repositoryName: string;
  sourceBranch: string | null;
  targetBranch: string | null;
  createdBy: string;
  reviewers: PullRequestReviewerView[];
  /** Null when ADO would not give the policy results (the reason is in checksError). */
  checks: AdoPolicyEvaluation[] | null;
  checksError?: string;
  /** Threads people opened (not ADO's system notes). */
  openThreads: PullRequestThreadView[];
  resolvedThreads: number;
}

export interface TaskPullRequestsData {
  configured: boolean;
  workItemId: number | null;
  /** Set when the pull requests shown are the parent's (a Review or QA Test). */
  parentWorkItemId: number | null;
  pullRequests: PullRequestView[];
  error?: string;
}

export function voteLabel(vote: number): string {
  if (vote >= 10) return "Approved";
  if (vote >= 5) return "Approved with suggestions";
  if (vote <= -10) return "Rejected";
  if (vote <= -5) return "Waiting for author";
  return "No vote";
}

const OPEN_THREAD = new Set(["active", "pending"]);

function threadViews(threads: AdoPullRequestThread[]): { open: PullRequestThreadView[]; resolved: number } {
  const open: PullRequestThreadView[] = [];
  let resolved = 0;
  for (const t of threads) {
    const people = t.comments.filter((c) => c.commentType !== "system" && c.content.trim());
    if (!people.length) continue;
    if (!OPEN_THREAD.has(t.status)) {
      resolved++;
      continue;
    }
    const first = people[0]!;
    const text = first.content.trim();
    open.push({
      id: t.id,
      status: t.status,
      filePath: t.filePath,
      line: t.line,
      author: first.author,
      excerpt: text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}…` : text,
      replies: people.length - 1,
    });
  }
  return { open: open.slice(0, MAX_THREADS), resolved };
}

function reviewerViews(reviewers: AdoPullRequestReviewer[] | undefined): PullRequestReviewerView[] {
  return (reviewers ?? [])
    .map((r) => ({ name: r.name, vote: r.vote, voteLabel: voteLabel(r.vote), isRequired: r.isRequired }))
    .sort((a, b) => Number(b.isRequired) - Number(a.isRequired) || a.name.localeCompare(b.name));
}

export async function pullRequestView(ado: AdoClient, ref: { repositoryId: string; pullRequestId: number }): Promise<PullRequestView> {
  const pr = await ado.getPullRequest(ref.repositoryId, ref.pullRequestId);
  const repositoryId = pr.repositoryId || ref.repositoryId;
  const [threads, checks] = await Promise.all([
    ado.listPullRequestThreads(repositoryId, pr.pullRequestId).catch(() => [] as AdoPullRequestThread[]),
    pr.projectId
      ? ado.listPolicyEvaluations(pr.projectId, pr.pullRequestId).then(
          (value) => ({ value, error: undefined as string | undefined }),
          (err: unknown) => ({ value: null, error: err instanceof Error ? err.message : String(err) }),
        )
      : Promise.resolve({ value: null, error: "ADO did not name the pull request's project" }),
  ]);
  const { open, resolved } = threadViews(threads);
  return {
    pullRequestId: pr.pullRequestId,
    title: pr.title,
    url: ado.pullRequestWebUrl(pr.repositoryName || repositoryId, pr.pullRequestId),
    status: pr.status,
    isDraft: pr.isDraft === true,
    mergeStatus: pr.mergeStatus ?? "",
    repositoryName: pr.repositoryName,
    sourceBranch: pr.sourceBranch,
    targetBranch: pr.targetBranch,
    createdBy: pr.createdBy ?? "",
    reviewers: reviewerViews(pr.reviewers),
    checks: checks.value,
    ...(checks.error ? { checksError: checks.error } : {}),
    openThreads: open,
    resolvedThreads: resolved,
  };
}

/**
 * Whether a work item's code is merged: "merged" when at least one linked pull request is
 * completed and none is still open (an abandoned one is ignored), "open" when one is active,
 * "none" when it has no pull request (or only abandoned ones).
 */
export async function mergeState(
  ado: Pick<AdoClient, "getPullRequest">,
  item: AdoWorkItem,
): Promise<"merged" | "open" | "none"> {
  let merged = 0;
  for (const ref of pullRequestRefs(item)) {
    const pr: AdoPullRequest | null = await ado.getPullRequest(ref.repositoryId, ref.pullRequestId).catch(() => null);
    if (!pr) continue;
    if (pr.status === "active") return "open";
    if (pr.status === "completed") merged++;
  }
  return merged ? "merged" : "none";
}

/** Registers the task tab's data. */
export function registerPullRequestView(deps: PluginDeps, links: Pick<LinkFeatures, "findLinkByIssue">): void {
  const { ctx } = deps;
  ctx.data.register(PR_VIEW_DATA_KEY, async (params): Promise<TaskPullRequestsData> => {
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    const issueId = typeof params.issueId === "string" ? params.issueId : "";
    const empty: TaskPullRequestsData = { configured: false, workItemId: null, parentWorkItemId: null, pullRequests: [] };
    if (!companyId || !issueId) return empty;
    if (!(await deps.settings(companyId))) return empty;
    const link = await links.findLinkByIssue(companyId, issueId);
    if (!link) return { ...empty, configured: true };
    try {
      const ado = await deps.adoClient(companyId);
      let item = await ado.getWorkItem(link.workItemId);
      let parentWorkItemId: number | null = null;
      const type = String(item.fields["System.WorkItemType"] ?? "").toLowerCase();
      const parent = Number(item.fields["System.Parent"] ?? 0);
      if (CHILD_OF_PR_TYPES.has(type) && parent && !pullRequestRefs(item).length) {
        item = await ado.getWorkItem(parent);
        parentWorkItemId = parent;
      }
      const pullRequests: PullRequestView[] = [];
      for (const ref of pullRequestRefs(item)) {
        pullRequests.push(await pullRequestView(ado, ref));
      }
      // Open first, then newest.
      pullRequests.sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || b.pullRequestId - a.pullRequestId);
      return { configured: true, workItemId: link.workItemId, parentWorkItemId, pullRequests };
    } catch (err) {
      return { configured: true, workItemId: link.workItemId, parentWorkItemId: null, pullRequests: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
}
