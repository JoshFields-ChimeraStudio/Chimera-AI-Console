import { describe, expect, it } from "vitest";
import { countFailures, createEscalation, overrideModel } from "../src/escalation/index.js";

const CO = "co-1";
const MODEL = "claude-opus-5-5";

interface Item {
  id: number;
  type: string;
  state: string;
  parent?: number;
  /** The states it moved to, oldest first. */
  history?: string[];
}

function setup(items: Item[], options: { model?: string | null; override?: string } = {}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const json = (i: Item) => ({
    id: i.id,
    rev: 1,
    url: "",
    fields: { "System.WorkItemType": i.type, "System.State": i.state, ...(i.parent ? { "System.Parent": i.parent } : {}) },
    relations: items.filter((c) => c.parent === i.id).map((c) => ({ rel: "System.LinkTypes.Hierarchy-Forward", url: `x/_apis/wit/workItems/${c.id}` })),
  });
  const ado = {
    getWorkItem: async (id: number) => json(byId.get(id)!),
    listUpdates: async (id: number) => (byId.get(id)!.history ?? []).map((s) => ({ fields: { "System.State": { newValue: s } } })),
  };
  const task = {
    id: "t-story",
    assigneeAgentId: "a-maple",
    assigneeAdapterOverrides: options.override ? { adapterConfig: { model: options.override } } : null,
  };
  const updates: Array<[string, unknown]> = [];
  const comments: string[] = [];
  const ctx = {
    issues: {
      update: async (id: string, patch: unknown) => void updates.push([id, patch]),
      createComment: async (_id: string, body: string) => void comments.push(body),
    },
    logger: { info() {}, warn() {} },
  };
  const escalation = createEscalation({
    deps: { ctx, adoClient: async () => ado } as never,
    links: { findTaskForWorkItem: async (_c: string, id: number) => (id === 10 ? (task as never) : null) },
    escalationModel: async () => (options.model === undefined ? MODEL : options.model),
  });
  const summary = (id: number) => ({ id, type: byId.get(id)!.type, state: byId.get(id)!.state, parentId: byId.get(id)!.parent ?? null }) as never;
  return { escalation, updates, comments, summary };
}

const story = { id: 10, type: "User Story", state: "In Review" };

describe("model escalation (D9)", () => {
  it("moves the builder's Story to the escalation model on the last round of review changes", async () => {
    const t = setup([story, { id: 11, type: "Review", state: "Changes Requested", parent: 10, history: ["In Review", "Changes Requested", "In Review", "Changes Requested"] }]);
    await t.escalation.onStateChanged(CO, t.summary(11));
    expect(t.updates).toEqual([["t-story", { assigneeAdapterOverrides: { adapterConfig: { model: MODEL } } }]]);
    expect(t.comments[0]).toContain(`Your next turns on ADO #10 run on **${MODEL}**`);
    expect(t.comments[0]).toContain("asked for changes 2 times");
  });

  it("leaves the first round of changes, and rounds before an approval, on the usual model", async () => {
    const first = setup([story, { id: 11, type: "Review", state: "Changes Requested", parent: 10, history: ["In Review", "Changes Requested"] }]);
    await first.escalation.onStateChanged(CO, first.summary(11));
    const reset = setup([story, { id: 11, type: "Review", state: "Changes Requested", parent: 10, history: ["Changes Requested", "Approved", "Changes Requested"] }]);
    await reset.escalation.onStateChanged(CO, reset.summary(11));
    expect([...first.updates, ...reset.updates]).toEqual([]);
  });

  it("counts QA failures across the Story's QA Tests", async () => {
    const once = setup([story, { id: 12, type: "QA Test", state: "Failed", parent: 10, history: ["Testing", "Failed"] }]);
    await once.escalation.onStateChanged(CO, once.summary(12));
    expect(once.updates).toEqual([]);

    const twice = setup([
      story,
      { id: 12, type: "QA Test", state: "Failed", parent: 10, history: ["Testing", "Failed"] },
      { id: 13, type: "QA Test", state: "Passed", parent: 10, history: ["Testing", "Failed", "Ready For Retest", "Passed"] },
      // A Defect's history is not a QA failure.
      { id: 14, type: "Defect", state: "Failed", parent: 10, history: ["Failed"] },
    ]);
    await twice.escalation.onStateChanged(CO, twice.summary(12));
    expect(twice.updates).toHaveLength(1);
    expect(twice.comments[0]).toContain("QA Tests have failed 2 times");
  });

  it("does nothing when turned off, already escalated, or not under a Story", async () => {
    const review = { id: 11, type: "Review", state: "Changes Requested", parent: 10, history: ["Changes Requested", "Changes Requested"] };
    const off = setup([story, review], { model: null });
    await off.escalation.onStateChanged(CO, off.summary(11));
    const done = setup([story, review], { override: MODEL });
    await done.escalation.onStateChanged(CO, done.summary(11));
    const feature = setup([{ ...story, type: "Feature" }, review]);
    await feature.escalation.onStateChanged(CO, feature.summary(11));
    expect([...off.updates, ...done.updates, ...feature.updates]).toEqual([]);
  });

  it("reads the override model and counts failures", () => {
    expect(overrideModel({ assigneeAdapterOverrides: { adapterConfig: { model: " x " } } } as never)).toBe("x");
    expect(overrideModel({ assigneeAdapterOverrides: null } as never)).toBeNull();
    expect(countFailures([{ fields: { "System.State": { newValue: "Failed" } } }, { fields: {} }])).toBe(1);
  });
});
