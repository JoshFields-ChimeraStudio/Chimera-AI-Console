import { describe, expect, it, vi } from "vitest";
import { AdoClient } from "../src/ado/client.js";
import { mergeState, pullRequestView, voteLabel } from "../src/pullrequests/view.js";

const pr = (over: Record<string, unknown> = {}) => ({
  pullRequestId: 12,
  title: "Add greeting",
  status: "active",
  repositoryId: "repo-1",
  repositoryName: "SimpleRepo",
  sourceBranch: "ai/804",
  targetBranch: "main",
  projectId: "proj-1",
  isDraft: false,
  mergeStatus: "succeeded",
  createdBy: "AI Team",
  reviewers: [
    { name: "Josh", vote: 0, isRequired: false, isContainer: false },
    { name: "Ladon", vote: -5, isRequired: true, isContainer: false },
  ],
  ...over,
});

describe("task pull request view (A5)", () => {
  it("labels votes", () => {
    expect([10, 5, 0, -5, -10].map(voteLabel)).toEqual(["Approved", "Approved with suggestions", "No vote", "Waiting for author", "Rejected"]);
  });

  it("shows reviewers, checks and the open threads people started", async () => {
    const ado = {
      getPullRequest: vi.fn(async () => pr()),
      pullRequestWebUrl: (repo: string, id: number) => `https://ado/_git/${repo}/pullrequest/${id}`,
      listPolicyEvaluations: vi.fn(async () => [{ name: "Build", status: "rejected", isBlocking: true }]),
      listPullRequestThreads: vi.fn(async () => [
        { id: 1, status: "active", filePath: "/README.md", line: 3, comments: [
          { id: 1, author: "AI Team", content: "[Ladon] Missing a test.", commentType: "text", publishedDate: null },
          { id: 2, author: "AI Team", content: "[Maple] Added.", commentType: "text", publishedDate: null },
        ] },
        { id: 2, status: "fixed", filePath: null, line: null, comments: [{ id: 1, author: "Josh", content: "Typo", commentType: "text", publishedDate: null }] },
        { id: 3, status: "active", filePath: null, line: null, comments: [{ id: 1, author: "ADO", content: "Ladon voted -5", commentType: "system", publishedDate: null }] },
      ]),
    };
    const view = await pullRequestView(ado as never, { repositoryId: "repo-1", pullRequestId: 12 });
    expect(view.url).toBe("https://ado/_git/SimpleRepo/pullrequest/12");
    expect(view.reviewers.map((r) => [r.name, r.voteLabel, r.isRequired])).toEqual([["Ladon", "Waiting for author", true], ["Josh", "No vote", false]]);
    expect(view.checks).toEqual([{ name: "Build", status: "rejected", isBlocking: true }]);
    expect(view.openThreads).toEqual([{ id: 1, status: "active", filePath: "/README.md", line: 3, author: "AI Team", excerpt: "[Ladon] Missing a test.", replies: 1 }]);
    expect(view.resolvedThreads).toBe(1);
  });

  it("still shows the pull request when ADO refuses the policy results", async () => {
    const ado = {
      getPullRequest: async () => pr(),
      pullRequestWebUrl: () => "u",
      listPolicyEvaluations: async () => { throw new Error("403"); },
      listPullRequestThreads: async () => [],
    };
    const view = await pullRequestView(ado as never, { repositoryId: "repo-1", pullRequestId: 12 });
    expect(view.checks).toBeNull();
    expect(view.checksError).toBe("403");
  });

  it("says whether a work item's code is merged", async () => {
    const item = (ids: number[]) => ({ id: 1, rev: 1, fields: {}, relations: ids.map((id) => ({ rel: "ArtifactLink", url: `vstfs:///Git/PullRequestId/p%2Fr%2F${id}` })) }) as never;
    const statuses: Record<number, string> = { 1: "abandoned", 2: "completed", 3: "active" };
    const ado = { getPullRequest: async (_r: string, id: number) => pr({ pullRequestId: id, status: statuses[id] }) as never };
    expect(await mergeState(ado, item([1, 2]))).toBe("merged");
    expect(await mergeState(ado, item([2, 3]))).toBe("open");
    expect(await mergeState(ado, item([1]))).toBe("none");
    expect(await mergeState(ado, item([]))).toBe("none");
  });

  it("reads reviewers and policy results from ADO", async () => {
    const urls: string[] = [];
    const client = new AdoClient({
      orgUrl: "https://dev.azure.com/Org",
      project: "AI Testing",
      pat: "p",
      fetch: async (url) => {
        urls.push(url);
        const body = url.includes("/policy/")
          ? { value: [
              { status: "approved", configuration: { isBlocking: true, isEnabled: true, type: { displayName: "Minimum number of reviewers" } } },
              { status: "running", configuration: { isBlocking: false, type: { displayName: "Build" }, settings: { displayName: "CI build" } } },
              { status: "approved", configuration: { isEnabled: false, type: { displayName: "Off" } } },
            ] }
          : { pullRequestId: 12, status: "active", isDraft: true, mergeStatus: "conflicts", repository: { id: "r1", name: "SimpleRepo", project: { id: "proj-1" } },
              reviewers: [{ displayName: "Ladon", vote: 10, isRequired: true }] };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    const got = await client.getPullRequest("r1", 12);
    expect([got.projectId, got.isDraft, got.mergeStatus, got.reviewers]).toEqual(["proj-1", true, "conflicts", [{ name: "Ladon", vote: 10, isRequired: true, isContainer: false }]]);
    expect(await client.listPolicyEvaluations("proj-1", 12)).toEqual([
      { name: "Minimum number of reviewers", status: "approved", isBlocking: true },
      { name: "CI build", status: "running", isBlocking: false },
    ]);
    expect(urls[1]).toBe(
      "https://dev.azure.com/Org/AI%20Testing/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproj-1%2F12&api-version=7.1-preview.1",
    );
  });
});
