import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createAdoPlugin } from "../src/worker.js";
import { SMOKE_ACTION_KEYS, SMOKE_DATA_KEY, SMOKE_STATE_KEY, smokeFileName, type CleanUpResult, type SmokeData, type StartResult } from "../src/smoke/index.js";
import { fakeLinkRepository, fakeWorkItemCacheRepository } from "./fakes.js";

const ORG = "https://dev.azure.com/ChimeraStudioSoftware";
const CO = "co-1";
const BASE_CONFIG = {
  orgUrl: ORG,
  project: "AI Testing",
  pat: { type: "secret_ref", secretId: "pat" },
  serviceBusConnection: { type: "secret_ref", secretId: "sb" },
};
const ROWAN = { id: "agent-rowan", companyId: CO, name: "Rowan", status: "idle" };
const USER = { companyId: CO, actor: { type: "user", userId: "josh" } };

interface Item {
  id: number;
  rev: number;
  type: string;
  state: string;
  title: string;
  parent?: number;
  fields: Record<string, unknown>;
}

const wiUrl = (id: number) => `${ORG}/_apis/wit/workItems/${id}`;

class FakeAdo {
  items = new Map<number, Item>();
  nextId = 900;
  patches: Array<{ id: number; ops: Array<{ op: string; path: string; value?: unknown }> }> = [];
  failPatch = new Set<number>();
  /** Types with no Removed state. */
  noRemoved = new Set<string>(["Documentation"]);

  add(item: Partial<Item> & { id: number; type: string }) {
    this.items.set(item.id, { rev: 1, state: "New", title: `Item ${item.id}`, fields: {}, ...item });
  }

  json(item: Item) {
    const children = [...this.items.values()].filter((i) => i.parent === item.id);
    return {
      id: item.id,
      rev: item.rev,
      url: wiUrl(item.id),
      fields: {
        "System.WorkItemType": item.type,
        "System.State": item.state,
        "System.Title": item.title,
        "System.ChangedBy": { displayName: "Josh" },
        "System.ChangedDate": "2026-11-19T10:00:00Z",
        ...(item.parent ? { "System.Parent": item.parent } : {}),
        ...item.fields,
      },
      relations: children.map((c) => ({ rel: "System.LinkTypes.Hierarchy-Forward", url: wiUrl(c.id) })),
    };
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const states = url.match(/\/workitemtypes\/([^/]+)\/states/);
    if (states) {
      const type = decodeURIComponent(states[1]!);
      const value = [{ name: "New" }, { name: "Completed" }, ...(this.noRemoved.has(type) ? [] : [{ name: "Removed" }])];
      return Response.json({ value });
    }
    if (url.includes("/_apis/wit/workitemtypes?")) return Response.json({ value: [] });
    if (url.includes("/wiql")) return Response.json({ workItems: [] });
    if (url.includes("/workitemsbatch")) {
      const { ids } = JSON.parse(String(init?.body));
      return Response.json({ value: ids.filter((id: number) => this.items.has(id)).map((id: number) => this.json(this.items.get(id)!)) });
    }
    if (url.match(/\/comments/)) return Response.json({ comments: [], totalCount: 0 });
    const create = url.match(/\/workitems\/\$([^?]+)\?/);
    if (create && method === "POST") {
      const ops = JSON.parse(String(init?.body)) as Array<{ path: string; value: unknown }>;
      const id = this.nextId++;
      const fields: Record<string, unknown> = {};
      for (const op of ops) fields[op.path.replace("/fields/", "")] = op.value;
      this.add({ id, type: decodeURIComponent(create[1]!), title: String(fields["System.Title"]), fields });
      return Response.json(this.json(this.items.get(id)!));
    }
    const wi = url.match(/\/workitems\/(\d+)\?/);
    if (wi) {
      const item = this.items.get(Number(wi[1]));
      if (!item) return new Response("missing", { status: 404 });
      if (method === "PATCH") {
        if (this.failPatch.has(item.id)) return new Response("nope", { status: 400 });
        const ops = JSON.parse(String(init?.body));
        this.patches.push({ id: item.id, ops });
        const state = ops.find((o: { path: string }) => o.path === "/fields/System.State");
        if (state) item.state = String(state.value);
        item.rev++;
      }
      return Response.json(this.json(item));
    }
    return new Response(`unexpected ${method} ${url}`, { status: 500 });
  }
}

function setup(config: Record<string, unknown> = { ...BASE_CONFIG, smokeTestAgent: "Rowan" }) {
  const ado = new FakeAdo();
  const plugin = createAdoPlugin({
    recoveryDelayMs: 0,
    linkRepository: () => fakeLinkRepository(),
    workItemCacheRepository: () => fakeWorkItemCacheRepository(),
    listenerFactory: () => ({ close: async () => {} }),
  });
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => ado.fetch(String(input), init));
  const harness = createTestHarness({ manifest, config });
  (harness.ctx.secrets as { resolve: unknown }).resolve = async (ref: { secretId: string }) => (ref.secretId === "pat" ? "pat-value" : "Endpoint=sb://x/;SharedAccessKeyName=l;SharedAccessKey=k");
  harness.seed({ agents: [ROWAN] as never });
  return { ado, plugin, harness, config };
}

type S = ReturnType<typeof setup>;

async function start(s: S) {
  await s.plugin.definition.setup(s.harness.ctx);
  await s.plugin.definition.onConfigChanged!(s.config, { companyId: CO });
}

const startSmoke = (s: S) => s.harness.performAction<StartResult>(SMOKE_ACTION_KEYS.start, { companyId: CO }, USER as never);
const cleanUp = (s: S) => s.harness.performAction<CleanUpResult | null>(SMOKE_ACTION_KEYS.cleanUp, { companyId: CO }, USER as never);
const record = (s: S) => s.harness.getState({ scopeKind: "company", scopeId: CO, stateKey: SMOKE_STATE_KEY }) as { epicId: number } | undefined;

afterEach(() => vi.unstubAllGlobals());

describe("smoke test (A10)", () => {
  it("declares the widget", () => {
    expect(manifest.ui?.slots?.some((slot) => slot.exportName === "AdoSmokeTest" && slot.type === "dashboardWidget")).toBe(true);
    expect((manifest.instanceConfigSchema as { properties: Record<string, unknown> }).properties.smokeTestAgent).toBeTruthy();
  });

  it("names the file from the creation time, to the second", () => {
    expect(smokeFileName(new Date("2026-11-19T22:12:05.123Z"))).toBe("smoke/hello-20261119-221205.txt");
    expect(smokeFileName(new Date("2026-11-19T22:12:06Z"))).not.toBe(smokeFileName(new Date("2026-11-19T22:12:05Z")));
  });

  it("is off until a smoke-test agent is set", async () => {
    const s = setup(BASE_CONFIG);
    await start(s);
    const data = await s.harness.getData<SmokeData>(SMOKE_DATA_KEY, { companyId: CO });
    expect(data).toMatchObject({ configured: true, agentName: null, epic: null });
    await expect(startSmoke(s)).rejects.toThrow(/smoke-test agent/);
  });

  it("creates the Epic with the smoke-test text and assigns it to the smoke-test agent", async () => {
    const s = setup();
    await start(s);
    const res = await startSmoke(s);
    expect(res).toMatchObject({ epicId: 900, assignedTo: "Rowan", cleanedUp: null });
    const epic = s.ado.items.get(900)!;
    expect(epic.type).toBe("Epic");
    expect(epic.title).toMatch(/^Smoke test: full workflow \(/);
    expect(String(epic.fields["System.Description"])).toContain("Instructions from Josh:");
    expect(String(epic.fields["System.Description"])).toContain("Date: ");
    // A new file every run, so a run never finds the last one's file on main.
    expect(String(epic.fields["System.Description"])).toMatch(/smoke\/hello-\d{8}-\d{6}\.txt/);
    expect(String(epic.fields["Microsoft.VSTS.Common.AcceptanceCriteria"])).toMatch(/smoke\/hello-\d{8}-\d{6}\.txt is on main/);
    expect(record(s)?.epicId).toBe(900);
    const issues = await s.harness.ctx.issues.list({ companyId: CO });
    expect(issues.some((i) => i.assigneeAgentId === ROWAN.id)).toBe(true);
    const data = await s.harness.getData<SmokeData>(SMOKE_DATA_KEY, { companyId: CO });
    expect(data.epic).toMatchObject({ id: 900, state: "New" });
    expect(data.joshSteps.length).toBeGreaterThan(0);
  });

  it("refuses anyone but a board user", async () => {
    const s = setup();
    await start(s);
    await expect(s.harness.performAction(SMOKE_ACTION_KEYS.start, { companyId: CO }, { companyId: CO, actor: { type: "agent", agentId: ROWAN.id } } as never)).rejects.toThrow(/board user/);
    await expect(s.harness.performAction(SMOKE_ACTION_KEYS.cleanUp, { companyId: CO }, { companyId: CO } as never)).rejects.toThrow(/board user/);
  });

  it("reset closes the previous tree top down, skips final items, then starts a new Epic", async () => {
    const s = setup();
    await start(s);
    await startSmoke(s);
    s.ado.add({ id: 10, type: "Documentation", parent: 900, state: "In Progress" });
    s.ado.add({ id: 11, type: "Document", parent: 10, state: "Completed" });
    s.ado.add({ id: 20, type: "Feature", parent: 900, state: "In Progress" });
    s.ado.add({ id: 21, type: "User Story", parent: 20, state: "In Testing" });
    s.ado.add({ id: 22, type: "Defect", parent: 21, state: "Ready For Retest" });
    const res = await startSmoke(s);
    expect(res.epicId).toBe(901);
    expect(res.cleanedUp).toMatchObject({ removed: [900, 10, 20, 21, 22], alreadyFinal: [11], failed: [], truncated: false });
    // Parents first, so nothing rolls up or wakes an owner on the way.
    expect(s.ado.patches.map((p) => p.id)).toEqual([900, 10, 20, 21, 22]);
    expect(s.ado.items.get(900)!.state).toBe("Removed");
    expect(s.ado.items.get(10)!.state).toBe("Completed"); // no Removed state for this type
    expect(s.ado.items.get(22)!.state).toBe("Removed");
    expect(String(s.ado.patches[0]!.ops.find((o) => o.path === "/fields/System.History")?.value)).toContain("[ADO plugin]");
    expect(record(s)?.epicId).toBe(901);
  });

  it("keeps the record and creates nothing when an item cannot be closed", async () => {
    const s = setup();
    await start(s);
    await startSmoke(s);
    s.ado.add({ id: 20, type: "Feature", parent: 900, state: "In Progress" });
    s.ado.failPatch.add(20);
    await expect(startSmoke(s)).rejects.toThrow(/could not be cleaned up completely.*#20/);
    expect(s.ado.items.has(901)).toBe(false);
    expect(record(s)?.epicId).toBe(900);
    s.ado.failPatch.clear();
    expect(await cleanUp(s)).toMatchObject({ removed: [20], alreadyFinal: [900] });
    expect(record(s)).toBeFalsy();
    expect(await cleanUp(s)).toBeNull();
  });
});
