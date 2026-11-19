/**
 * A5 (part): wake the agent working on a work item when its pull request is
 * completed or abandoned, or when anyone else (a person or another agent)
 * comments on it.
 *
 * Pull request events are signals only, like work item events: the PR, its
 * linked work items and its comments are re-read from ADO each time, and
 * plugin state records what was already announced, so a redelivered,
 * reordered or dropped event never announces twice and a later event catches
 * up on anything missed. The agents told are the one assigned to the Paperclip
 * task linked to each work item the PR is linked to, and, for new comments,
 * the reviewers: the agents on unfinished Review items under those work items.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AdoPullRequest, AdoPullRequestComment, AdoWorkItem } from "../ado/client.js";
import { FINAL_STATES, REVIEW_TYPE } from "../workflow/rules.js";

type Issue = NonNullable<Awaited<ReturnType<PluginContext["issues"]["get"]>>>;

/** The ADO calls this needs (AdoClient has them). */
export interface PullRequestReader {
  getPullRequest(repositoryId: string | null, pullRequestId: number): Promise<AdoPullRequest>;
  listPullRequestWorkItemIds(repositoryId: string, pullRequestId: number): Promise<number[]>;
  listPullRequestComments(repositoryId: string, pullRequestId: number): Promise<AdoPullRequestComment[]>;
  pullRequestWebUrl(repository: string, pullRequestId: number): string;
  getWorkItem(id: number): Promise<AdoWorkItem>;
}

export interface PullRequestDeps {
  ctx: Pick<PluginContext, "state" | "issues" | "agents" | "logger">;
  findTaskForWorkItem(companyId: string, workItemId: number): Promise<Issue | null>;
}

/** What has been announced for one pull request. */
export interface PullRequestRecord {
  status: string;
  /** "<threadId>:<commentId>" of every comment already seen, announced or not. */
  seenComments: string[];
}

export interface PullRequestOutcome {
  pullRequestId: number;
  status: string;
  /** Comments that are news for someone (before leaving out each agent's own). */
  newComments: number;
  statusChanged: boolean;
  /** Paperclip task ids that were told and woken. */
  notifiedTasks: string[];
}

/** Final pull request states that need the agent. */
const CLOSED_STATUSES = new Set(["completed", "abandoned"]);
/** Task statuses a wakeup cannot reach; the task is reopened first. */
const REOPEN_STATUSES = new Set(["done", "backlog"]);
const MAX_SEEN = 2000;
const MAX_COMMENT_CHARS = 1500;

export const PR_WAKE_REASONS = {
  comments: "ado_pull_request_comments",
  reviewComments: "ado_pull_request_review_comments",
  completed: "ado_pull_request_completed",
  abandoned: "ado_pull_request_abandoned",
} as const;

function stateKey(companyId: string, repositoryId: string, pullRequestId: number) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey: `pr:${repositoryId}:${pullRequestId}` };
}

function commentKey(c: AdoPullRequestComment): string {
  return `${c.threadId}:${c.commentId}`;
}

/** An agent signs its pull request comments "[Name] ..."; an agent is not told about its own. */
function signedBy(content: string, agentName: string): boolean {
  const m = content.trimStart().match(/^\[([^\]\n]{1,60})\]/);
  return !!m && m[1]!.trim().toLowerCase() === agentName.trim().toLowerCase();
}

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_COMMENT_CHARS ? `${t.slice(0, MAX_COMMENT_CHARS)}…` : t;
}

function quote(text: string): string {
  return clip(text)
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
}

export function createPullRequestNotifier(deps: PullRequestDeps) {
  const { ctx } = deps;

  async function agentName(companyId: string, agentId: string): Promise<string | null> {
    const a = await ctx.agents.get(agentId, companyId).catch(() => null);
    return a?.name ?? null;
  }

  function prLine(pr: AdoPullRequest, url: string): string {
    const repo = pr.repositoryName ? ` in ${pr.repositoryName}` : "";
    return `pull request [#${pr.pullRequestId} ${pr.title}](${url})${repo}`;
  }

  function commentsNotice(pr: AdoPullRequest, url: string, comments: AdoPullRequestComment[]): string {
    const lines = [`New comments on ${prLine(pr, url)}:`, ""];
    for (const c of comments) {
      const where = c.filePath ? ` on \`${c.filePath}\`${c.line ? ` line ${c.line}` : ""}` : "";
      lines.push(`**${c.author || "Someone"}**${where} (thread ${c.threadId}):`, quote(c.content), "");
    }
    lines.push("Read each thread on the pull request, make the changes it asks for on the pull request's branch, push, and reply on the thread.");
    return lines.join("\n");
  }

  function reviewCommentsNotice(pr: AdoPullRequest, url: string, comments: AdoPullRequestComment[], reviewId: number): string {
    const lines = [`New comments on ${prLine(pr, url)}, which you review in Review #${reviewId}:`, ""];
    for (const c of comments) {
      const where = c.filePath ? ` on \`${c.filePath}\`${c.line ? ` line ${c.line}` : ""}` : "";
      lines.push(`**${c.author || "Someone"}**${where} (thread ${c.threadId}):`, quote(c.content), "");
    }
    lines.push(
      "Read each thread. Reply where a reply is for you (an answer to your finding, a question). " +
        "Review the new commits when your Review is set Ready For Review again, as your instructions say.",
    );
    return lines.join("\n");
  }

  /** Unfinished Review items under a work item, with their agents' tasks. */
  async function reviewTasksUnder(companyId: string, ado: PullRequestReader, workItemId: number): Promise<Array<{ reviewId: number; task: Issue }>> {
    const item = await ado.getWorkItem(workItemId);
    const out: Array<{ reviewId: number; task: Issue }> = [];
    for (const r of item.relations ?? []) {
      if (r.rel !== "System.LinkTypes.Hierarchy-Forward") continue;
      const id = Number(r.url.match(/\/workItems\/(\d+)$/i)?.[1]);
      if (!Number.isInteger(id) || id <= 0) continue;
      const child = await ado.getWorkItem(id);
      if (String(child.fields["System.WorkItemType"] ?? "").toLowerCase() !== REVIEW_TYPE.toLowerCase()) continue;
      const state = String(child.fields["System.State"] ?? "").toLowerCase();
      if (FINAL_STATES.some((f) => f.toLowerCase() === state)) continue;
      const task = await deps.findTaskForWorkItem(companyId, id);
      if (task?.assigneeAgentId && task.status !== "cancelled") out.push({ reviewId: id, task });
    }
    return out;
  }

  function statusNotice(pr: AdoPullRequest, url: string): string {
    if (pr.status === "completed") {
      const into = pr.sourceBranch && pr.targetBranch ? `: \`${pr.sourceBranch}\` was merged into \`${pr.targetBranch}\`` : "";
      return `The ${prLine(pr, url)} was completed${into}. Finish the work item as your instructions say.`;
    }
    return `The ${prLine(pr, url)} was abandoned without merging. Check its comments for why, and report or block the work item as your instructions say.`;
  }

  /** Reopen a task a wakeup cannot reach, post the notice, wake the assignee. Errors in the wake are logged, not thrown. */
  async function notify(companyId: string, task: Issue, body: string, reason: string, idempotencyKey: string): Promise<void> {
    if (REOPEN_STATUSES.has(task.status)) {
      await ctx.issues.update(task.id, { status: "todo" }, companyId);
    }
    await ctx.issues.createComment(task.id, body, companyId);
    try {
      const res = await ctx.issues.requestWakeup(task.id, companyId, { reason, contextSource: "ado.pull-request", idempotencyKey });
      if (!res.queued) ctx.logger.info("Pull request wakeup was not queued", { companyId, issueId: task.id, reason });
    } catch (err) {
      // The comment is on the task; the agent sees it on its next run.
      ctx.logger.warn("Could not wake the agent for a pull request change", {
        companyId,
        issueId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function onPullRequestEvent(
    companyId: string,
    ado: PullRequestReader,
    target: { pullRequestId: number; repositoryId: string | null },
  ): Promise<PullRequestOutcome> {
    const pr = await ado.getPullRequest(target.repositoryId, target.pullRequestId);
    const repositoryId = pr.repositoryId || target.repositoryId || "";
    const key = stateKey(companyId, repositoryId, pr.pullRequestId);
    const prev = ((await ctx.state.get(key)) as PullRequestRecord | null) ?? null;
    const seen = new Set(prev?.seenComments ?? []);

    const comments = await ado.listPullRequestComments(repositoryId, pr.pullRequestId);
    const unseen = comments.filter((c) => !seen.has(commentKey(c)));
    // Comments on an open pull request are news (each agent is spared its own, below); ADO's system notes are not.
    const fresh = pr.status === "active" ? unseen.filter((c) => c.commentType !== "system" && c.content.trim()) : [];
    const statusChanged = CLOSED_STATUSES.has(pr.status) && prev?.status !== pr.status;

    const notifiedTasks: string[] = [];
    if (fresh.length || statusChanged) {
      const url = ado.pullRequestWebUrl(pr.repositoryName || repositoryId, pr.pullRequestId);
      const tasks = new Map<string, Issue>();
      const reviewers = new Map<string, { reviewId: number; task: Issue }>();
      for (const id of await ado.listPullRequestWorkItemIds(repositoryId, pr.pullRequestId)) {
        const task = await deps.findTaskForWorkItem(companyId, id);
        if (task?.assigneeAgentId && task.status !== "cancelled") tasks.set(task.id, task);
        if (fresh.length && !statusChanged) {
          for (const r of await reviewTasksUnder(companyId, ado, id)) reviewers.set(r.task.id, r);
        }
      }
      if (!tasks.size) {
        ctx.logger.info("Pull request changed but no linked work item has an agent's task", {
          companyId,
          pullRequestId: pr.pullRequestId,
        });
      }
      for (const task of tasks.values()) {
        if (statusChanged) {
          const reason = pr.status === "completed" ? PR_WAKE_REASONS.completed : PR_WAKE_REASONS.abandoned;
          await notify(companyId, task, statusNotice(pr, url), reason, `ado-pr:${repositoryId}:${pr.pullRequestId}:${pr.status}`);
        } else {
          const name = await agentName(companyId, task.assigneeAgentId!);
          const forThem = name ? fresh.filter((c) => !signedBy(c.content, name)) : fresh;
          if (!forThem.length) continue;
          const ids = forThem.map(commentKey).join(",");
          await notify(companyId, task, commentsNotice(pr, url, forThem), PR_WAKE_REASONS.comments, `ado-pr:${repositoryId}:${pr.pullRequestId}:c:${ids}`);
        }
        notifiedTasks.push(task.id);
      }
      // Reviewers hear about comments by anyone else (the builder's replies, Josh's notes), not about their own.
      for (const { reviewId, task } of reviewers.values()) {
        if (tasks.has(task.id)) continue;
        const name = await agentName(companyId, task.assigneeAgentId!);
        const forThem = name ? fresh.filter((c) => !signedBy(c.content, name)) : fresh;
        if (!forThem.length) continue;
        const ids = forThem.map(commentKey).join(",");
        await notify(companyId, task, reviewCommentsNotice(pr, url, forThem, reviewId), PR_WAKE_REASONS.reviewComments,
          `ado-pr:${repositoryId}:${pr.pullRequestId}:r:${reviewId}:${ids}`);
        notifiedTasks.push(task.id);
      }
    }

    // Saved last: if a notice failed, the redelivered event tries again.
    const record: PullRequestRecord = {
      status: pr.status,
      seenComments: [...seen, ...unseen.map(commentKey)].slice(-MAX_SEEN),
    };
    await ctx.state.set(key, record);
    return { pullRequestId: pr.pullRequestId, status: pr.status, newComments: fresh.length, statusChanged, notifiedTasks };
  }

  return { onPullRequestEvent };
}

export type PullRequestNotifier = ReturnType<typeof createPullRequestNotifier>;
