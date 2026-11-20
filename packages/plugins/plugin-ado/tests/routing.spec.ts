import { describe, expect, it } from "vitest";
import { builderRoleOf, createRouter, dependenciesOf, forAgentOf, parseRoutes, withTag } from "../src/routing/index.js";

const CO = "co-1";
const AGENTS = [
  { id: "a-ouro", name: "Ouroboros", status: "idle" },
  { id: "a-hydra", name: "Hydra", status: "idle" },
  { id: "a-jorm", name: "Jormungandr", status: "paused" },
  { id: "a-ladon", name: "Ladon", status: "idle" },
  { id: "a-apophis", name: "Apophis", status: "idle" },
];

interface Item {
  id: number;
  type: string;
  state: string;
  parent?: number;
  tags?: string;
  description?: string;
  /** Linked pull requests: id and status. */
  prs?: Array<{ id: number; status: string }>;
}

function setup(items: Item[], routes = [{ role: "backend", agents: "Ouroboros, Hydra", wipLimit: 1 }]) {
  const byId = new Map(items.map((i) => [i.id, { ...i }]));
  /** Linked tasks: work item id -> { agentId, status }. */
  const tasks = new Map<number, { id: string; agentId: string; status: string }>();
  const assigned: Array<[number, string]> = [];
  const comments: Array<[number, string]> = [];
  const json = (i: Item) => ({
    id: i.id,
    rev: 1,
    url: "",
    fields: {
      "System.WorkItemType": i.type,
      "System.State": i.state,
      ...(i.parent ? { "System.Parent": i.parent } : {}),
      ...(i.tags ? { "System.Tags": i.tags } : {}),
      ...(i.description ? { "System.Description": i.description } : {}),
    },
    relations: [
      ...[...byId.values()].filter((c) => c.parent === i.id).map((c) => ({ rel: "System.LinkTypes.Hierarchy-Forward", url: `x/_apis/wit/workItems/${c.id}` })),
      ...(i.prs ?? []).map((p) => ({ rel: "ArtifactLink", url: `vstfs:///Git/PullRequestId/proj%2Frepo%2F${p.id}` })),
    ],
  });
  const prStatus = new Map<number, string>();
  for (const i of items) for (const p of i.prs ?? []) prStatus.set(p.id, p.status);
  const ado = {
    getWorkItem: async (id: number) => json(byId.get(id)!),
    addComment: async (id: number, html: string) => void comments.push([id, html]),
    webUrl: (id: number) => `https://ado/${id}`,
    getPullRequest: async (_repo: string, id: number) => ({ pullRequestId: id, status: prStatus.get(id) ?? "active" }),
    queryWorkItemIds: async () => [...byId.values()].filter((i) => ["User Story", "Bug"].includes(i.type) && i.state === "New").map((i) => i.id),
  };
  const ctx = {
    agents: { list: async () => AGENTS },
    issues: {
      list: async (q: { assigneeAgentId: string }) =>
        [...tasks.entries()].filter(([, t]) => t.agentId === q.assigneeAgentId).map(([wi, t]) => ({ id: t.id, status: t.status, wi })),
    },
    logger: { info() {}, warn() {} },
  };
  const links = {
    findTaskForWorkItem: async (_c: string, id: number) => {
      const t = tasks.get(id);
      return t ? ({ id: t.id, assigneeAgentId: t.agentId, status: t.status } as never) : null;
    },
    findLinkByIssue: async (_c: string, issueId: string) => {
      const entry = [...tasks.entries()].find(([, t]) => t.id === issueId);
      if (!entry) return null;
      const it = byId.get(entry[0])!;
      return { workItemId: it.id, type: it.type, state: it.state, title: `Item ${it.id}` } as never;
    },
  };
  const assigner = {
    assign: async (r: { workItemId: number; agentId: string }) => {
      tasks.set(r.workItemId, { id: `t-${r.workItemId}`, agentId: r.agentId, status: "todo" });
      assigned.push([r.workItemId, AGENTS.find((a) => a.id === r.agentId)!.name]);
      return {} as never;
    },
  };
  const router = createRouter({
    deps: { ctx, adoClient: async () => ado } as never,
    links: links as never,
    assigner: assigner as never,
    routes: async () => parseRoutes(routes),
  });
  const summary = (id: number) => ({ id, type: byId.get(id)!.type, state: byId.get(id)!.state }) as never;
  return { router, byId, tasks, assigned, comments, summary, prStatus };
}

describe("builder routes (A6)", () => {
  it("reads tags, dependencies and the setting", () => {
    expect(builderRoleOf("agent:Orochi; builder:backend")).toBe("backend");
    expect(forAgentOf("for:Ladon; repo:Products")).toBe("Ladon");
    expect(withTag("agent:Orochi; builder:web", "builder:", "backend")).toBe("agent:Orochi; builder:backend");
    expect(dependenciesOf("<p>Needs the API.</p><p>Depends on #12, #13 and #14.</p>")).toEqual([12, 13, 14]);
    expect(dependenciesOf(undefined)).toEqual([]);
    expect(parseRoutes([{ role: " backend ", agents: "Ouroboros, , Hydra", wipLimit: 0 }, { role: "", agents: "x" }, { role: "web", agents: "" }])).toEqual([
      { role: "backend", agents: ["Ouroboros", "Hydra"], wipLimit: 1 },
    ]);
  });

  it("on Ready For Work assigns for: items, then Stories to the least-loaded builder up to the limit, and says who waits", async () => {
    const s = setup([
      { id: 100, type: "Feature", state: "Ready For Work" },
      { id: 101, type: "User Story", state: "New", parent: 100, tags: "builder:backend" },
      { id: 102, type: "Review", state: "New", parent: 101, tags: "for:Ladon" },
      { id: 103, type: "QA Test", state: "New", parent: 101, tags: "for:Apophis" },
      { id: 104, type: "Task", state: "New", parent: 101 },
      { id: 111, type: "User Story", state: "New", parent: 100, tags: "builder:backend" },
      { id: 121, type: "User Story", state: "New", parent: 100, tags: "builder:backend" },
      { id: 131, type: "User Story", state: "New", parent: 100 }, // no tag: the director's
      { id: 141, type: "User Story", state: "New", parent: 100, tags: "builder:mobile" },
    ]);
    // Hydra already holds an open Story elsewhere.
    s.byId.set(900, { id: 900, type: "User Story", state: "In Progress" });
    s.tasks.set(900, { id: "t-900", agentId: "a-hydra", status: "in_progress" });

    const res = await s.router.onStateChanged(CO, s.summary(100));
    expect(res).toBeUndefined();
    expect(s.assigned).toEqual([
      [102, "Ladon"],
      [103, "Apophis"],
      [101, "Ouroboros"],
      [104, "Ouroboros"],
    ]);
    const feature = s.comments.find(([id]) => id === 100)![1];
    expect(feature).toContain("[ADO plugin] Assigned by the builder routes: #102 to Ladon, #103 to Apophis, #101 to Ouroboros, #104 to Ouroboros.");
    expect(feature).toContain("#111 (every backend builder holds 1 open Story)");
    expect(feature).toContain("#141 (no route for builder role mobile)");
    expect(feature).not.toContain("#131");
    expect(s.comments.find(([id]) => id === 101)![1]).toContain("Assigned to Ouroboros: builder role backend; Ouroboros held 0 of 1 open Stories.");

    // Hydra's Story finishes: the next waiting Story gets the free slot, in backlog order.
    s.byId.get(900)!.state = "Completed";
    s.tasks.get(900)!.status = "done";
    await s.router.onStateChanged(CO, s.summary(900));
    expect(s.assigned.slice(4)).toEqual([[111, "Hydra"]]);
  });

  it("holds a Story until what it depends on is done, and leaves Stories of unapproved Features alone", async () => {
    const s = setup(
      [
        { id: 200, type: "Feature", state: "Ready For Work" },
        { id: 201, type: "User Story", state: "New", parent: 200, tags: "builder:backend" },
        { id: 202, type: "User Story", state: "New", parent: 200, tags: "builder:backend", description: "Depends on #201" },
        { id: 300, type: "Feature", state: "Ready For Approval" },
        { id: 301, type: "User Story", state: "New", parent: 300, tags: "builder:backend" },
      ],
      [{ role: "backend", agents: "Ouroboros, Hydra", wipLimit: 2 }],
    );
    await s.router.onStateChanged(CO, s.summary(200));
    expect(s.assigned).toEqual([[201, "Ouroboros"]]);
    expect(s.comments.find(([id]) => id === 200)![1]).toContain("#202 (waits for #201 to be merged)");

    s.byId.get(201)!.state = "Completed";
    s.tasks.get(201)!.status = "done";
    await s.router.onStateChanged(CO, s.summary(201));
    // #202 starts; #301's Feature is not approved, so it stays.
    expect(s.assigned.slice(1)).toEqual([[202, "Ouroboros"]]);
  });

  it("starts a dependent Story once its dependency's pull request is merged (A5)", async () => {
    const s = setup(
      [
        { id: 200, type: "Feature", state: "Ready For Work" },
        { id: 201, type: "User Story", state: "In Testing", parent: 200, tags: "builder:backend", prs: [{ id: 7, status: "abandoned" }, { id: 8, status: "active" }] },
        { id: 202, type: "User Story", state: "New", parent: 200, tags: "builder:backend", description: "Depends on #201 and #203" },
        { id: 203, type: "Task", state: "In Progress", parent: 200 },
      ],
      [{ role: "backend", agents: "Ouroboros", wipLimit: 2 }],
    );
    s.tasks.set(201, { id: "t-201", agentId: "a-ouro", status: "in_progress" });
    await s.router.onStateChanged(CO, s.summary(200));
    expect(s.comments.find(([id]) => id === 200)![1]).toContain("#202 (waits for #201 to be merged and #203 to finish)");

    s.byId.get(203)!.state = "Completed";
    s.prStatus.set(8, "completed");
    await s.router.fillSlots(CO, "pull request #8 merged");
    expect(s.assigned).toEqual([[202, "Ouroboros"]]);
  });

  it("shows the queues without assigning anything (A6 queue view)", async () => {
    const s = setup(
      [
        { id: 600, type: "Feature", state: "Ready For Work" },
        { id: 601, type: "User Story", state: "In Progress", parent: 600, tags: "builder:backend" },
        { id: 602, type: "User Story", state: "New", parent: 600, tags: "builder:backend" },
        { id: 603, type: "User Story", state: "New", parent: 600, tags: "builder:backend", description: "Depends on #601" },
        { id: 700, type: "Feature", state: "Ready For Approval" },
        { id: 701, type: "User Story", state: "New", parent: 700, tags: "builder:backend" },
      ],
      [{ role: "backend", agents: "Ouroboros, Hydra, Nobody", wipLimit: 1 }],
    );
    s.tasks.set(601, { id: "t-601", agentId: "a-ouro", status: "in_progress" });
    const q = await s.router.queues(CO);
    expect(s.assigned).toEqual([]);
    expect(q.routes[0]!.builders.map((b) => [b.name, b.status, b.held.map((h) => h.workItemId)])).toEqual([
      ["Ouroboros", "idle", [601]],
      ["Hydra", "idle", []],
      ["Nobody", "missing", []],
    ]);
    expect(q.ready.map((r) => [r.workItemId, r.agent])).toEqual([[602, "Hydra"]]);
    expect(q.waiting.map((w) => [w.workItemId, w.why])).toEqual([
      [603, "waits for #601 to be merged"],
      [701, "its Feature #700 is not approved yet"],
    ]);
    expect(q.waiting[0]!.url).toBe("https://ado/603");
  });

  it("does nothing without routes, and skips paused agents", async () => {
    const none = setup([{ id: 400, type: "Feature", state: "Ready For Work" }, { id: 401, type: "User Story", state: "New", parent: 400, tags: "builder:backend" }], []);
    await none.router.onStateChanged(CO, none.summary(400));
    expect(none.assigned).toEqual([]);
    expect(none.comments).toEqual([]);

    const paused = setup(
      [{ id: 500, type: "Feature", state: "Ready For Work" }, { id: 501, type: "User Story", state: "New", parent: 500, tags: "builder:infra" }],
      [{ role: "infra", agents: "Jormungandr", wipLimit: 1 }],
    );
    await paused.router.onStateChanged(CO, paused.summary(500));
    expect(paused.assigned).toEqual([]);
    expect(paused.comments[0]![1]).toContain("#501 (no infra builder is available (Jormungandr: missing, paused or not approved))");
  });
});
