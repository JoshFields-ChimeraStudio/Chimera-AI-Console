import { describe, expect, it, vi } from "vitest";
import { createPullRequestNotifier, PR_WAKE_REASONS, type PullRequestReader } from "../src/pullrequests/index.js";
import type { AdoPullRequest, AdoPullRequestComment } from "../src/ado/client.js";

const CO = "co-1";
const REPO = "repo-1";

function comment(threadId: number, commentId: number, content: string, extra: Partial<AdoPullRequestComment> = {}): AdoPullRequestComment {
  return { threadId, commentId, author: "Josh", content, commentType: "text", publishedDate: null, filePath: null, line: null, ...extra };
}

function setup(
  opts: { tasks?: Record<number, any>; workItems?: number[]; agents?: string[]; items?: Record<number, { type: string; state: string; children?: number[] }> } = {},
) {
  const state = new Map<string, unknown>();
  const pr: AdoPullRequest = {
    pullRequestId: 403,
    title: "Add greeting",
    status: "active",
    repositoryId: REPO,
    repositoryName: "SimpleRepo",
    sourceBranch: "ai/804-readme-greeting",
    targetBranch: "main",
  };
  let comments: AdoPullRequestComment[] = [];
  const tasks: Record<number, any> = opts.tasks ?? { 804: { id: "task-maple", status: "in_review", assigneeAgentId: "maple" } };
  const ado: PullRequestReader = {
    getPullRequest: vi.fn(async () => ({ ...pr })),
    listPullRequestWorkItemIds: vi.fn(async () => opts.workItems ?? [804]),
    listPullRequestComments: vi.fn(async () => comments),
    pullRequestWebUrl: (repo, id) => `https://ado/_git/${repo}/pullrequest/${id}`,
    getWorkItem: vi.fn(async (id: number) => {
      const it = opts.items?.[id] ?? { type: "User Story", state: "In Review" };
      return {
        id,
        rev: 1,
        fields: { "System.WorkItemType": it.type, "System.State": it.state },
        relations: (it.children ?? []).map((c) => ({ rel: "System.LinkTypes.Hierarchy-Forward", url: `https://ado/_apis/wit/workItems/${c}` })),
      } as any;
    }),
  };
  const issues = {
    update: vi.fn(async (..._args: unknown[]) => ({})),
    createComment: vi.fn(async (..._args: unknown[]) => ({})),
    requestWakeup: vi.fn(async (..._args: unknown[]) => ({ queued: true, runId: "r" })),
  };
  const ctx = {
    state: {
      get: vi.fn(async (k: any) => state.get(k.stateKey) ?? null),
      set: vi.fn(async (k: any, v: unknown) => void state.set(k.stateKey, v)),
    },
    issues,
    agents: { get: vi.fn(async (id: string) => ({ id, name: id === "maple" ? "Maple" : id === "juniper" ? "Juniper" : id })) },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
  const merged: number[] = [];
  const notifier = createPullRequestNotifier({
    ctx: ctx as any,
    findTaskForWorkItem: async (_c, id) => tasks[id] ?? null,
    onMerged: async (_c, p) => void merged.push(p.pullRequestId),
  });
  const run = () => notifier.onPullRequestEvent(CO, ado, { pullRequestId: 403, repositoryId: REPO });
  return {
    pr,
    ado,
    issues,
    state,
    run,
    merged,
    setComments: (c: AdoPullRequestComment[]) => void (comments = c),
  };
}

describe("pull request notifications", () => {
  it("tells the reviewers on unfinished Reviews about others' comments, not their own, and skips finished Reviews", async () => {
    const s = setup({
      tasks: {
        804: { id: "task-maple", status: "in_review", assigneeAgentId: "maple" },
        821: { id: "task-juniper", status: "in_review", assigneeAgentId: "juniper" },
        822: { id: "task-ladon", status: "done", assigneeAgentId: "ladon" },
      },
      items: {
        804: { type: "User Story", state: "Changes Requested", children: [821, 822, 830] },
        821: { type: "Review", state: "Changes Requested" },
        822: { type: "Review", state: "Completed" },
        830: { type: "Task", state: "In Progress" },
      },
    });
    s.setComments([comment(7, 1, "[Juniper] Please rename the heading."), comment(7, 2, "[Maple] Renamed in 3f2a1c.")]);
    const out = await s.run();
    expect(out.notifiedTasks).toEqual(["task-maple", "task-juniper"]);
    const toJuniper = s.issues.createComment.mock.calls.find((c) => c[0] === "task-juniper")![1] as string;
    expect(toJuniper).toContain("which you review in Review #821");
    expect(toJuniper).toContain("Renamed in 3f2a1c.");
    expect(toJuniper).not.toContain("rename the heading");
    const toMaple = s.issues.createComment.mock.calls.find((c) => c[0] === "task-maple")![1] as string;
    expect(toMaple).toContain("rename the heading");
    expect(toMaple).not.toContain("Renamed in 3f2a1c.");
    expect(s.issues.requestWakeup).toHaveBeenCalledWith("task-juniper", CO, {
      reason: PR_WAKE_REASONS.reviewComments,
      contextSource: "ado.pull-request",
      idempotencyKey: "ado-pr:repo-1:403:r:821:7:2",
    });
    expect(s.issues.requestWakeup).not.toHaveBeenCalledWith("task-ladon", expect.anything(), expect.anything());
  });

  it("tells and wakes the linked task's agent about a person's new comments, once", async () => {
    const s = setup();
    s.setComments([comment(7, 1, "Please say hello to the world instead.", { filePath: "/README.md", line: 3 })]);
    const out = await s.run();
    expect(out).toMatchObject({ newComments: 1, statusChanged: false, notifiedTasks: ["task-maple"] });
    const body = s.issues.createComment.mock.calls[0]![1] as string;
    expect(body).toContain("New comments on pull request [#403 Add greeting](https://ado/_git/SimpleRepo/pullrequest/403) in SimpleRepo");
    expect(body).toContain("**Josh** on `/README.md` line 3 (thread 7):\n> Please say hello to the world instead.");
    expect(s.issues.requestWakeup).toHaveBeenCalledWith("task-maple", CO, {
      reason: PR_WAKE_REASONS.comments,
      contextSource: "ado.pull-request",
      idempotencyKey: "ado-pr:repo-1:403:c:7:1",
    });
    // The same comments again (a redelivery or a later push event): nothing new.
    expect((await s.run()).notifiedTasks).toEqual([]);
    expect(s.issues.createComment).toHaveBeenCalledTimes(1);
    // A reply on the thread is new.
    s.setComments([comment(7, 1, "Please say hello to the world instead."), comment(7, 2, "Also fix the typo.")]);
    expect((await s.run()).newComments).toBe(1);
    expect(s.issues.createComment.mock.calls[1]![1]).toContain("Also fix the typo.");
    expect(s.issues.createComment.mock.calls[1]![1]).not.toContain("hello to the world");
  });

  it("ignores system comments and the agent's own signed comments, but tells it another agent's, and records all as seen", async () => {
    const s = setup();
    s.setComments([
      comment(1, 1, "Josh voted 10", { commentType: "system" }),
      comment(2, 2, "[maple] Fixed in abc123"),
      comment(3, 1, "   "),
    ]);
    expect(await s.run()).toMatchObject({ newComments: 1, notifiedTasks: [] });
    expect(s.issues.createComment).not.toHaveBeenCalled();
    expect((s.state.get("pr:repo-1:403") as any).seenComments).toEqual(["1:1", "2:2", "3:1"]);
    // Another agent's review comment is news for Maple.
    s.setComments([comment(4, 1, "[Juniper] Please change line 4 to the new wording.")]);
    expect((await s.run()).notifiedTasks).toEqual(["task-maple"]);
    expect(s.issues.createComment.mock.calls[0]![1]).toContain("[Juniper] Please change line 4");
  });

  it("announces completion once, with the branches, and reopens a done task so it can be woken", async () => {
    const s = setup({ tasks: { 804: { id: "task-maple", status: "done", assigneeAgentId: "maple" } } });
    await s.run(); // active: nothing to say
    expect(s.issues.createComment).not.toHaveBeenCalled();
    s.pr.status = "completed";
    s.ado.getPullRequest = vi.fn(async () => ({ ...s.pr }));
    const out = await s.run();
    expect(out).toMatchObject({ statusChanged: true, notifiedTasks: ["task-maple"] });
    expect(s.issues.update).toHaveBeenCalledWith("task-maple", { status: "todo" }, CO);
    expect(s.issues.createComment.mock.calls[0]![1]).toContain("was completed: `ai/804-readme-greeting` was merged into `main`.");
    expect(s.issues.requestWakeup.mock.calls[0]![2]).toMatchObject({ reason: PR_WAKE_REASONS.completed, idempotencyKey: "ado-pr:repo-1:403:completed" });
    expect((await s.run()).statusChanged).toBe(false);
    expect(s.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("reports a merge once, for the Stories waiting on it (A5)", async () => {
    const s = setup();
    await s.run();
    expect(s.merged).toEqual([]);
    s.pr.status = "completed";
    await s.run();
    await s.run();
    expect(s.merged).toEqual([403]);
    const abandoned = setup();
    abandoned.pr.status = "abandoned";
    await abandoned.run();
    expect(abandoned.merged).toEqual([]);
  });

  it("announces an abandoned pull request, and not comments on a closed one", async () => {
    const s = setup();
    s.pr.status = "abandoned";
    s.setComments([comment(9, 1, "Not needed any more.")]);
    const out = await s.run();
    expect(out).toMatchObject({ statusChanged: true, newComments: 0 });
    expect(s.issues.requestWakeup.mock.calls[0]![2]).toMatchObject({ reason: PR_WAKE_REASONS.abandoned });
    expect(s.issues.createComment.mock.calls[0]![1]).toContain("was abandoned without merging");
  });

  it("wakes nobody when no linked work item has an agent's task, and skips cancelled tasks", async () => {
    const s = setup({
      workItems: [804, 805, 806],
      tasks: { 805: { id: "t-person", status: "todo", assigneeAgentId: null }, 806: { id: "t-cancelled", status: "cancelled", assigneeAgentId: "maple" } },
    });
    s.setComments([comment(1, 1, "Looks wrong")]);
    expect((await s.run()).notifiedTasks).toEqual([]);
    expect(s.issues.requestWakeup).not.toHaveBeenCalled();
  });

  it("keeps the comment when the wakeup fails, and saves nothing when posting fails so a redelivery retries", async () => {
    const s = setup();
    s.setComments([comment(1, 1, "Please change this")]);
    s.issues.createComment.mockRejectedValueOnce(new Error("db down"));
    await expect(s.run()).rejects.toThrow("db down");
    expect(s.state.get("pr:repo-1:403")).toBeUndefined();
    s.issues.requestWakeup.mockRejectedValueOnce(new Error("Issue is blocked by unresolved blockers"));
    expect((await s.run()).notifiedTasks).toEqual(["task-maple"]);
    expect((s.state.get("pr:repo-1:403") as any).seenComments).toEqual(["1:1"]);
  });
});
