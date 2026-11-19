import { describe, expect, it, vi } from "vitest";
import { changesSince, CHILD_WAKE_REASON, createWorkItemWatcher, WORK_ITEM_WAKE_REASON, type WatchReader } from "../src/watch/index.js";
import type { AdoComment, AdoWorkItem, AdoWorkItemUpdate, WorkItemSummary } from "../src/ado/client.js";

const CO = "co-1";
const SVC = "AI Service";

const upd = (rev: number, revisedBy: string, fields: AdoWorkItemUpdate["fields"]): AdoWorkItemUpdate => ({ rev, revisedBy, revisedDate: null, fields });
const stateChange = (from: string, to: string) => ({ "System.State": { oldValue: from, newValue: to } });
const tagged = (name: string) => ({ "System.Tags": { newValue: `agent:${name}` } });
const comment = (id: number, createdBy: string, text: string, createdDate = "2026-11-17T21:00:00Z"): AdoComment => ({
  id,
  text,
  format: "html",
  renderedText: null,
  createdBy,
  createdDate,
});

function summary(id: number, state: string, rev: number, extra: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return { id, rev, type: "User Story", state, title: `Item ${id}`, changedBy: null, changedDate: null, webUrl: `https://ado/${id}`, parentId: null, stackRank: null, ...extra };
}

function workItem(id: number, fields: Record<string, unknown>, children: number[] = []): AdoWorkItem {
  return {
    id,
    rev: 1,
    url: "u",
    fields,
    relations: children.map((c) => ({ rel: "System.LinkTypes.Hierarchy-Forward", url: `https://dev.azure.com/o/_apis/wit/workItems/${c}`, attributes: {} })),
  } as unknown as AdoWorkItem;
}

function setup() {
  const state = new Map<string, unknown>();
  const tasks: Record<number, any> = {
    811: { id: "task-maple", status: "in_review", assigneeAgentId: "maple" },
    812: { id: "task-juniper", status: "blocked", assigneeAgentId: "juniper" },
    813: { id: "task-ladon", status: "done", assigneeAgentId: "ladon" },
  };
  let updates: AdoWorkItemUpdate[] = [];
  let comments: AdoComment[] = [];
  const items: Record<number, AdoWorkItem> = {
    811: workItem(811, { "System.State": "In Review" }, [812, 813, 814]),
    812: workItem(812, { "System.WorkItemType": "Review", "System.State": "Changes Requested", "System.Tags": "agent:Juniper" }),
    813: workItem(813, { "System.WorkItemType": "Review", "System.State": "Completed" }),
    814: workItem(814, { "System.WorkItemType": "Task", "System.State": "New", "System.Tags": "review" }), // a Task, even tagged: not a Review
  };
  const ado: WatchReader = {
    listUpdates: vi.fn(async () => updates),
    listComments: vi.fn(async () => ({ comments, totalCount: comments.length })),
    getWorkItem: vi.fn(async (id: number) => items[id]!),
    updateWorkItem: vi.fn(async (id: number, ops: any[]) => {
      for (const op of ops) if (op.path === "/fields/System.State") items[id]!.fields["System.State"] = op.value;
      return items[id]!;
    }),
    webUrl: (id) => `https://ado/${id}`,
  };
  const issues = {
    update: vi.fn(async (..._a: unknown[]) => ({})),
    createComment: vi.fn(async (..._a: unknown[]) => ({})),
    requestWakeup: vi.fn(async (..._a: unknown[]) => ({ queued: true, runId: "r" })),
  };
  const names: Record<string, string> = { maple: "Maple", juniper: "Juniper", ladon: "Ladon" };
  const ctx = {
    state: {
      get: vi.fn(async (k: any) => state.get(k.stateKey) ?? null),
      set: vi.fn(async (k: any, v: unknown) => void state.set(k.stateKey, v)),
    },
    issues,
    agents: { get: vi.fn(async (id: string) => ({ id, name: names[id] })) },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
  const watcher = createWorkItemWatcher({
    ctx: ctx as any,
    findTaskForWorkItem: async (_c, id) => tasks[id] ?? null,
    serviceAccountName: async () => SVC,
  });
  return {
    watcher,
    ado,
    issues,
    state,
    tasks,
    items,
    setUpdates: (u: AdoWorkItemUpdate[]) => void (updates = u),
    setComments: (c: AdoComment[]) => void (comments = c),
    change: (item: WorkItemSummary, baseline = { rev: 1, syncedAt: "2026-11-17T20:00:00Z" }) => watcher.onWorkItemChanged(CO, ado, item, baseline),
  };
}

describe("roll-ups (A4)", () => {
  function feature(s: ReturnType<typeof setup>, state: string, stories: Record<number, string>) {
    s.items[900] = workItem(900, { "System.WorkItemType": "Feature", "System.State": state }, Object.keys(stories).map(Number));
    for (const [id, st] of Object.entries(stories)) s.items[Number(id)] = workItem(Number(id), { "System.WorkItemType": "User Story", "System.State": st });
    s.tasks[900] = { id: "task-rowan", status: "in_review", assigneeAgentId: "rowan" };
  }
  const story = (id: number, state: string, rev: number) => summary(id, state, rev, { parentId: 900 });

  it("completes an In Progress Feature when its last Story is completed, and does not wake its owner for Story moves", async () => {
    const s = setup();
    feature(s, "In Progress", { 811: "In Testing", 901: "Removed" });
    s.setUpdates([upd(4, SVC, { ...stateChange("In Testing", "Completed"), ...tagged("Maple") })]);
    s.items[811]!.fields["System.State"] = "Completed";
    const out = await s.change(story(811, "Completed", 4));
    expect(out.rolledUp).toBe(900);
    const ops = (s.ado.updateWorkItem as any).mock.calls[0];
    expect(ops[0]).toBe(900);
    expect(ops[1]).toEqual([
      { op: "test", path: "/rev", value: 1 },
      { op: "replace", path: "/fields/System.State", value: "Completed" },
      { op: "add", path: "/fields/System.History", value: "[ADO plugin] Completed automatically: every work item under this Feature is Completed or Removed (last: #811)." },
    ]);
    expect(s.issues.requestWakeup).not.toHaveBeenCalledWith("task-rowan", expect.anything(), expect.anything());
  });

  it("leaves the Feature while a Story is open, all are Removed, or the Feature is not In Progress; wakes the owner for a Blocked Story", async () => {
    const s = setup();
    feature(s, "In Progress", { 811: "Completed", 901: "In Review" });
    s.setUpdates([upd(4, SVC, stateChange("In Testing", "Completed"))]);
    expect((await s.change(story(811, "Completed", 4))).rolledUp).toBeUndefined();

    feature(s, "In Progress", { 811: "Removed" });
    s.state.clear();
    s.setUpdates([upd(4, SVC, stateChange("New", "Removed"))]);
    expect((await s.change(story(811, "Removed", 4))).rolledUp).toBeUndefined();

    feature(s, "Refining", { 811: "Completed" });
    s.state.clear();
    s.setUpdates([upd(4, SVC, stateChange("In Testing", "Completed"))]);
    expect((await s.change(story(811, "Completed", 4))).rolledUp).toBeUndefined();
    expect(s.ado.updateWorkItem).not.toHaveBeenCalled();

    feature(s, "In Progress", { 811: "Blocked" });
    s.state.clear();
    s.setUpdates([upd(4, SVC, { ...stateChange("In Progress", "Blocked"), ...tagged("Maple") })]);
    const out = await s.change(story(811, "Blocked", 4));
    expect(out.notified).toContain("task-rowan");
  });
});

describe("who changed a work item", () => {
  it("names the agent from its tag, carried over revisions that do not touch the tags", () => {
    const lines = changesSince(
      [
        upd(1, "Josh", { "System.Title": { newValue: "x" } }),
        upd(2, SVC, { ...stateChange("New", "In Progress"), ...tagged("Maple") }),
        upd(3, SVC, stateChange("In Progress", "In Review")),
        upd(4, SVC, { ...stateChange("In Review", "Changes Requested"), ...tagged("Juniper") }),
        upd(5, "Josh", { "Microsoft.VSTS.Common.AcceptanceCriteria": { oldValue: "a", newValue: "b" } }),
      ],
      1,
      SVC,
    );
    expect(lines.map((l) => [l.rev, l.actor.name, l.actor.agent, l.text])).toEqual([
      [2, "Maple", true, "changed the state from New to **In Progress**"],
      [3, "Maple", true, "changed the state from In Progress to **In Review**"],
      [4, "Juniper", true, "changed the state from In Review to **Changes Requested**"],
      [5, "Josh", false, "edited the acceptance criteria"],
    ]);
  });
});

describe("telling agents apart when ADO reports another account name (Rowan's loop)", () => {
  it("uses the [Name] signature in the history and a changed agent tag, not only the account name", () => {
    const josh = "Josh Fields AI Team"; // the PAT's account, not the configured "AI Service"
    const lines = changesSince(
      [
        upd(2, josh, { ...stateChange("New", "Refining"), "System.History": { newValue: "[Rowan] Changed state from New to Refining." }, ...tagged("Rowan") }),
        upd(3, josh, { ...stateChange("Refining", "Ready For Approval"), "System.History": { newValue: "<div>[Rowan] Changed state from Refining to Ready For Approval.</div>" } }),
        upd(4, "Josh", { "System.Tags": { oldValue: "agent:Rowan", newValue: "agent:Rowan; urgent" }, "System.Title": { newValue: "New title" } }),
      ],
      1,
      SVC,
    );
    expect(lines.map((l) => [l.rev, l.actor.name, l.actor.agent])).toEqual([
      [2, "Rowan", true],
      [3, "Rowan", true],
      [4, "Josh", false],
    ]);
  });

  it("does not wake an agent for its own signed changes and comments", async () => {
    const s = setup();
    const josh = "Josh Fields AI Team";
    s.setUpdates([upd(2, josh, { ...stateChange("In Progress", "In Review"), "System.History": { newValue: "[Maple] Changed state from In Progress to In Review." } })]);
    s.setComments([comment(7, josh, "[Maple] Opened pull request 405.")]);
    expect((await s.change(summary(811, "In Review", 2))).notified).toEqual([]);
    expect(s.issues.createComment).not.toHaveBeenCalled();
  });
});

describe("the work item drives its task", () => {
  it("wakes the assignee when a person or another agent changes its item, not for its own changes, once", async () => {
    const s = setup();
    s.setUpdates([
      upd(2, SVC, { ...stateChange("In Progress", "In Review"), ...tagged("Maple") }),
      upd(3, SVC, { ...stateChange("In Review", "Changes Requested"), ...tagged("Juniper") }),
      upd(4, "Josh", { "System.Description": { newValue: "<p>New text</p>" } }),
    ]);
    const out = await s.change(summary(811, "Changes Requested", 4));
    expect(out.notified).toEqual(["task-maple"]);
    const body = s.issues.createComment.mock.calls[0]![1] as string;
    expect(body).toContain("[ADO #811 Item 811](https://ado/811) changed:");
    expect(body).toContain("- **Juniper (agent)** changed the state from In Review to **Changes Requested**");
    expect(body).toContain("- **Josh** edited the description");
    expect(body).not.toContain("Maple (agent)");
    expect(body).toContain("(now **Changes Requested**)");
    expect(s.issues.requestWakeup).toHaveBeenCalledWith("task-maple", CO, { reason: WORK_ITEM_WAKE_REASON, contextSource: "ado.work-item", idempotencyKey: "ado-wi:811:4" });
    // Redelivered: nothing new.
    expect((await s.change(summary(811, "Changes Requested", 4))).notified).toEqual([]);
    // The assignee's own change alone wakes nobody.
    s.setUpdates([upd(5, SVC, { ...stateChange("Changes Requested", "In Progress"), ...tagged("Maple") })]);
    expect((await s.change(summary(811, "In Progress", 5))).notified).toEqual([]);
    expect(s.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("tells the assignee about comments since the task was linked, by people and other agents, but not its own", async () => {
    const s = setup();
    s.setComments([
      comment(1, "Josh", "<p>Old note from before the link</p>", "2026-11-17T19:00:00Z"),
      comment(2, SVC, "[Maple] I opened the pull request."),
      comment(3, SVC, "[Juniper] Verdict: changes requested."),
      comment(4, "Josh", "<p>Please also update the docs.</p>"),
    ]);
    s.setUpdates([upd(2, SVC, {}), upd(3, SVC, {}), upd(4, "Josh", {})]);
    await s.change(summary(811, "In Review", 4));
    const body = s.issues.createComment.mock.calls[0]![1] as string;
    expect(body).toContain("- **Juniper (agent)** commented:\n> Verdict: changes requested.");
    expect(body).toContain("- **Josh** commented:\n> Please also update the docs.");
    expect(body).not.toContain("Old note");
    expect(body).not.toContain("I opened the pull request");
    // Seen now: a later event with one more comment tells only that one.
    s.setComments([...[1, 2, 3, 4].map((i) => comment(i, "Josh", `c${i}`)), comment(5, "Josh", "<p>One more thing.</p>")]);
    s.setUpdates([upd(5, "Josh", {})]);
    await s.change(summary(811, "In Review", 5));
    const second = s.issues.createComment.mock.calls[1]![1] as string;
    expect(second).toContain("One more thing.");
    expect(second).not.toContain("c4");
  });

  it("closes the task when the item reaches a final state, without waking anyone", async () => {
    const s = setup();
    s.setUpdates([upd(6, "Josh", stateChange("Ready To Merge", "Completed"))]);
    const out = await s.change(summary(811, "Completed", 6));
    expect(out).toEqual({ notified: [], closed: true });
    expect(s.issues.update).toHaveBeenCalledWith("task-maple", { status: "done" }, CO);
    expect(s.issues.requestWakeup).not.toHaveBeenCalled();
    s.tasks[811] = { ...s.tasks[811], status: "in_review" };
    s.setUpdates([upd(7, "Josh", stateChange("New", "Removed"))]);
    await s.change(summary(811, "Removed", 7));
    expect(s.issues.update).toHaveBeenLastCalledWith("task-maple", { status: "cancelled" }, CO);
  });

  it("reopens a done task when someone moves its item out of a final state", async () => {
    const s = setup();
    s.tasks[811] = { ...s.tasks[811], status: "done" };
    s.setUpdates([upd(8, "Josh", stateChange("Completed", "In Progress"))]);
    expect((await s.change(summary(811, "In Progress", 8))).notified).toEqual(["task-maple"]);
    expect(s.issues.update).toHaveBeenCalledWith("task-maple", { status: "todo" }, CO);
  });

  it("tells the owner of the parent when someone else changes a child's state, and the child's agent when it is handed over", async () => {
    const s = setup();
    s.tasks[812] = { ...s.tasks[812], status: "in_review" };
    // Juniper approves her Review: Maple, who owns the Story above it, is told.
    s.setUpdates([upd(5, SVC, { ...stateChange("In Review", "Approved"), ...tagged("Juniper") })]);
    const out = await s.change(summary(812, "Approved", 5, { type: "Review", parentId: 811 }));
    expect(out.notified).toEqual(["task-maple"]);
    expect(s.issues.requestWakeup).toHaveBeenCalledWith("task-maple", CO, {
      reason: CHILD_WAKE_REASON,
      contextSource: "ado.work-item",
      idempotencyKey: "ado-child:812:5",
    });
    expect(s.issues.createComment.mock.calls[0]![1]).toContain(
      "Review [ADO #812 Item 812](https://ado/812) under your ADO #811 changed:\n\n- **Juniper (agent)** changed the state from In Review to **Approved**",
    );
    // Maple hands it back for review: Juniper (its assignee) is told; Maple is not told about her own move.
    s.issues.requestWakeup.mockClear();
    s.setUpdates([upd(6, SVC, { ...stateChange("Approved", "Ready For Review"), ...tagged("Maple") })]);
    expect((await s.change(summary(812, "Ready For Review", 6, { type: "Review", parentId: 811 }))).notified).toEqual(["task-juniper"]);
    expect(s.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("tells the parent's owner about a child with no linked task, from this event only, and reads nothing when no one owns the parent", async () => {
    const s = setup();
    s.setUpdates([upd(1, "Hydra QA", stateChange("", "New")), upd(2, SVC, { ...stateChange("New", "Failed"), ...tagged("Hydra") })]);
    // 899 has no linked task: only its latest revision is news.
    const out = await s.change(summary(899, "Failed", 2, { type: "QA Test", parentId: 811 }));
    expect(out.notified).toEqual(["task-maple"]);
    expect(s.issues.createComment.mock.calls[0]![1]).toContain("- **Hydra (agent)** changed the state from New to **Failed**");
    expect(s.issues.createComment.mock.calls[0]![1]).not.toContain("to **New**");
    const reads = (s.ado.listUpdates as any).mock.calls.length;
    expect((await s.change(summary(898, "Failed", 2, { type: "QA Test", parentId: 999 }))).notified).toEqual([]);
    expect((s.ado.listUpdates as any).mock.calls.length).toBe(reads);
  });

  it("puts a task closed before its item back to waiting, and leaves it when the item is final", async () => {
    const s = setup();
    const task = { id: "task-maple", status: "done" } as any;
    expect(await s.watcher.onTaskClosed(CO, task, "In Review")).toBe(true);
    expect(s.issues.update).toHaveBeenCalledWith("task-maple", { status: "in_review" }, CO);
    expect(s.issues.createComment.mock.calls[0]![1]).toContain("This task stays open while its ADO work item is **In Review**");
    expect(await s.watcher.onTaskClosed(CO, task, "Blocked")).toBe(true);
    expect(s.issues.update).toHaveBeenLastCalledWith("task-maple", { status: "blocked" }, CO);
    expect(await s.watcher.onTaskClosed(CO, task, "Completed")).toBe(false);
    expect(await s.watcher.onTaskClosed(CO, { ...task, status: "in_review" }, "In Review")).toBe(false);
    expect(s.issues.requestWakeup).not.toHaveBeenCalled();
  });

  it("saves nothing when posting fails, so a redelivery retries", async () => {
    const s = setup();
    s.setUpdates([upd(3, "Josh", stateChange("In Review", "Changes Requested"))]);
    s.issues.createComment.mockRejectedValueOnce(new Error("db down"));
    await expect(s.change(summary(811, "Changes Requested", 3))).rejects.toThrow("db down");
    expect(s.state.get("wi-watch:811")).toBeUndefined();
    expect((await s.change(summary(811, "Changes Requested", 3))).notified).toEqual(["task-maple"]);
  });
});
