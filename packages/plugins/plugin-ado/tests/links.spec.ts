import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { createAdoPlugin } from "../src/worker.js";
import {
  ADO_LINK_ORIGIN_KIND,
  LINK_ACTION_KEYS,
  LINK_DATA_KEYS,
  isUniqueViolation,
  orgName,
  parseWorkItemId,
  type AdoLink,
  type IssueLinkData,
  type LinkResult,
} from "../src/links/index.js";
import { fakeLinkRepository as fakeRepository } from "./fakes.js";
import type { ListenerHandlers } from "../src/ado/servicebus.js";

const ORG = "https://dev.azure.com/ChimeraStudioSoftware";
const CO = "co-1";
const CONFIG = {
  orgUrl: ORG,
  project: "AI Testing",
  pat: { type: "secret_ref", secretId: "pat" },
  serviceBusConnection: { type: "secret_ref", secretId: "sb" },
};

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: randomUUID(),
    companyId: CO,
    title: "Write the docs",
    identifier: "CHI-1",
    status: "todo",
    originKind: "manual",
    originId: null,
    ...overrides,
  } as Issue;
}

interface AdoItemState {
  state: string;
  rev: number;
}

function setup() {
  const items = new Map<number, AdoItemState>([[123, { state: "Active", rev: 4 }], [456, { state: "New", rev: 1 }]]);
  const listeners: ListenerHandlers[] = [];
  const repo = fakeRepository();
  const plugin = createAdoPlugin({
    recoveryDelayMs: 0,
    linkRepository: () => repo,
    listenerFactory: (_c, _q, handlers) => {
      listeners.push(handlers);
      return { close: async () => {} };
    },
  });
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/wiql")) return Response.json({ workItems: [] });
    // The work item watcher reads history and comments of linked items.
    if (/\/workItems\/\d+\/updates/i.test(url)) return Response.json({ value: [] });
    if (/\/workItems\/\d+\/comments/i.test(url)) return Response.json({ comments: [], totalCount: 0 });
    if (url.includes("/workitemsbatch")) {
      const { ids } = JSON.parse(String(init?.body));
      return Response.json({ value: ids.filter((id: number) => items.has(id)).map((id: number) => adoItem(id, items.get(id)!)) });
    }
    const m = url.match(/\/workitems\/(\d+)/);
    if (m) {
      const state = items.get(Number(m[1]));
      return state ? Response.json(adoItem(Number(m[1]), state)) : new Response("missing", { status: 404 });
    }
    return new Response("unexpected", { status: 500 });
  });
  const harness = createTestHarness({ manifest, config: CONFIG });
  (harness.ctx.secrets as { resolve: unknown }).resolve = async (ref: { secretId: string }) => (ref.secretId === "pat" ? "pat-value" : "Endpoint=sb://x/;SharedAccessKeyName=l;SharedAccessKey=k");
  return { plugin, harness, repo, items, listeners };
}

function adoItem(id: number, s: AdoItemState) {
  return {
    id,
    rev: s.rev,
    url: "u",
    fields: { "System.WorkItemType": "User Story", "System.State": s.state, "System.Title": `Item ${id}`, "System.ChangedBy": { displayName: "Josh" } },
  };
}

async function start(s: ReturnType<typeof setup>) {
  await s.plugin.definition.setup(s.harness.ctx);
  await s.plugin.definition.onConfigChanged!(CONFIG, { companyId: CO });
  await vi.waitFor(() => expect(s.listeners).toHaveLength(1));
}

const linkAction = (s: ReturnType<typeof setup>, issueId: string, workItemId: unknown) =>
  s.harness.performAction<LinkResult>(LINK_ACTION_KEYS.link, { issueId, workItemId }, { companyId: CO, actor: { type: "user", userId: "josh" } });
const unlinkAction = (s: ReturnType<typeof setup>, issueId: string) =>
  s.harness.performAction<{ ok: boolean; unlinked?: boolean; error?: string }>(LINK_ACTION_KEYS.unlink, { issueId }, { companyId: CO });
const getIssue = (s: ReturnType<typeof setup>, id: string) => s.harness.ctx.issues.get(id, CO);

describe("link helpers", () => {
  it("derives the org name from the organization URL", () => {
    expect(orgName("https://dev.azure.com/ChimeraStudioSoftware/")).toBe("ChimeraStudioSoftware");
    expect(orgName("https://chimera.visualstudio.com")).toBe("chimera");
  });

  it("accepts 123, '123' and '#123' as work item IDs", () => {
    expect(parseWorkItemId(123)).toBe(123);
    expect(parseWorkItemId(" #123 ")).toBe(123);
    expect(parseWorkItemId("12a")).toBeNull();
    expect(parseWorkItemId("0")).toBeNull();
    expect(parseWorkItemId(undefined)).toBeNull();
  });

  it("migration targets the namespace the host derives for this plugin", () => {
    // Same derivation as derivePluginDatabaseNamespace in server/src/services/plugin-database.ts.
    const namespace = `plugin_${manifest.database!.namespaceSlug}_${createHash("sha256").update(manifest.id).digest("hex").slice(0, 10)}`;
    const sql = readFileSync(new URL("../migrations/001_ado_links.sql", import.meta.url), "utf8");
    expect(sql).toContain(`CREATE TABLE ${namespace}.ado_links`);
    expect(manifest.database!.coreReadTables).toContain("issues");
  });

  it("declares the capabilities A2 needs", () => {
    for (const cap of ["issues.read", "issues.update", "database.namespace.migrate", "database.namespace.read", "database.namespace.write", "ui.action.register"]) {
      expect(manifest.capabilities).toContain(cap);
    }
    expect(manifest.ui?.slots?.find((slot) => slot.exportName === "AdoTaskLink")).toMatchObject({ type: "toolbarButton", entityTypes: ["issue"] });
  });
});

describe("linking a task to a work item", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("links by ID: sets the task's origin, stores the item and shows it", async () => {
    const s = setup();
    const task = issue();
    s.harness.seed({ issues: [task] });
    await start(s);

    const res = await linkAction(s, task.id, "#123");
    expect(res).toMatchObject({ ok: true, link: { workItemId: 123, state: "Active", type: "User Story", title: "Item 123", rev: 4 } });
    const updated = await getIssue(s, task.id);
    expect(updated).toMatchObject({ originKind: ADO_LINK_ORIGIN_KIND, originId: "ChimeraStudioSoftware/AI Testing/123" });

    const data = await s.harness.getData<IssueLinkData>(LINK_DATA_KEYS.issueLink, { companyId: CO, issueId: task.id });
    expect(data.configured).toBe(true);
    expect(data.link).toMatchObject({ workItemId: 123, url: `${ORG}/AI%20Testing/_workitems/edit/123` });
  });

  it("rejects an item that does not exist in ADO and leaves the task alone", async () => {
    const s = setup();
    const task = issue();
    s.harness.seed({ issues: [task] });
    await start(s);
    expect(await linkAction(s, task.id, 999)).toEqual({ ok: false, error: "ADO #999 was not found in project AI Testing" });
    expect((await getIssue(s, task.id))!.originKind).toBe("manual");
    expect(s.repo.rows.size).toBe(0);
  });

  it("rejects an item already linked to another task and names that task", async () => {
    const s = setup();
    const first = issue({ identifier: "CHI-1", title: "First" });
    const second = issue({ identifier: "CHI-2", title: "Second" });
    s.harness.seed({ issues: [first, second] });
    await start(s);
    expect((await linkAction(s, first.id, 123)).ok).toBe(true);
    expect(await linkAction(s, second.id, 123)).toEqual({ ok: false, error: "ADO #123 is already linked to task CHI-1" });
    expect((await getIssue(s, second.id))!.originKind).toBe("manual");
  });

  it("also finds an existing link from the task origin alone (a task created by A3 or before the table row)", async () => {
    const s = setup();
    const existing = issue({ identifier: "CHI-7", title: "From ADO", originKind: ADO_LINK_ORIGIN_KIND as never, originId: "ChimeraStudioSoftware/AI Testing/123" });
    const task = issue({ identifier: "CHI-8" });
    s.harness.seed({ issues: [existing, task] });
    await start(s);
    expect(await linkAction(s, task.id, 123)).toEqual({ ok: false, error: "ADO #123 is already linked to task CHI-7" });
  });

  it("reports a concurrent link of the same item (unique violation) as already linked", async () => {
    const s = setup();
    const first = issue({ identifier: "CHI-1", title: "Private title" });
    const second = issue({ identifier: "CHI-2" });
    s.harness.seed({ issues: [first, second] });
    await start(s);
    // The other link's row exists but its task origin is not set yet, and our pre-check ran just before it.
    s.repo.rows.set(first.id, { issueId: first.id, companyId: CO, org: "ChimeraStudioSoftware", project: "AI Testing", workItemId: 123, type: "", state: "", url: "u", rev: 1, syncedAt: "" });
    const realFind = s.repo.findByWorkItem.bind(s.repo);
    let calls = 0;
    s.repo.findByWorkItem = async (companyId, key) => (++calls === 1 ? null : realFind(companyId, key));
    s.repo.insert = async () => {
      throw Object.assign(new Error("Failed query: INSERT INTO plugin_ado_3dc5cc6a90.ado_links"), { data: { code: "23505" } });
    };
    expect(await linkAction(s, second.id, 123)).toEqual({ ok: false, error: "ADO #123 is already linked to task CHI-1" });
    expect((await getIssue(s, second.id))!.originKind).toBe("manual");
  });

  it("recognises a unique violation however the host passes it on", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint "ado_links_pkey"'))).toBe(true);
    expect(isUniqueViolation(new Error("connection reset"))).toBe(false);
  });

  it("refuses to relink a linked task to another item, and to overwrite another origin", async () => {
    const s = setup();
    const task = issue();
    const routineRun = issue({ originKind: "routine_execution" as never, originId: "routine-1" });
    s.harness.seed({ issues: [task, routineRun] });
    await start(s);
    await linkAction(s, task.id, 123);
    expect(await linkAction(s, task.id, 456)).toEqual({ ok: false, error: "This task is already linked to ADO #123; unlink it first" });
    expect(await linkAction(s, routineRun.id, 456)).toEqual({ ok: false, error: 'Only ordinary tasks can be linked; this task\'s origin is "routine_execution"' });
    // Linking the same item again is a refresh, not an error.
    s.items.set(123, { state: "Resolved", rev: 5 });
    expect(await linkAction(s, task.id, 123)).toMatchObject({ ok: true, link: { state: "Resolved", rev: 5 } });
  });

  it("validates input", async () => {
    const s = setup();
    const task = issue();
    s.harness.seed({ issues: [task] });
    await start(s);
    expect(await linkAction(s, task.id, "abc")).toEqual({ ok: false, error: "Enter a work item ID, for example 123" });
    expect(await linkAction(s, randomUUID(), 123)).toEqual({ ok: false, error: "Task not found" });
  });

  it("unlinks: restores the plain origin and removes the stored link", async () => {
    const s = setup();
    const task = issue();
    s.harness.seed({ issues: [task] });
    await start(s);
    await linkAction(s, task.id, 123);
    expect(await unlinkAction(s, task.id)).toEqual({ ok: true, unlinked: true });
    expect(await getIssue(s, task.id)).toMatchObject({ originKind: "manual", originId: null });
    expect(s.repo.rows.size).toBe(0);
    expect(await unlinkAction(s, task.id)).toEqual({ ok: true, unlinked: false });
    // The item can now be linked to another task.
    const other = issue({ identifier: "CHI-2" });
    s.harness.seed({ issues: [other] });
    expect((await linkAction(s, other.id, 123)).ok).toBe(true);
  });

  it("does not link when the plugin is not configured for the company", async () => {
    const s = setup();
    const task = issue();
    s.harness.seed({ issues: [task] });
    s.harness.setConfig({});
    await s.plugin.definition.setup(s.harness.ctx);
    expect(await linkAction(s, task.id, 123)).toEqual({ ok: false, error: "The Azure DevOps plugin is not configured for this company" });
    const data = await s.harness.getData<IssueLinkData>(LINK_DATA_KEYS.issueLink, { companyId: CO, issueId: task.id });
    expect(data).toEqual({ configured: false, link: null });
  });
});

describe("keeping links current", () => {
  afterEach(() => vi.unstubAllGlobals());

  const updatedEvent = (id: number) => ({ id: `evt-${id}`, eventType: "workitem.updated", resource: { workItemId: id } });

  it("refreshes the state of a linked task on a live event, and ignores unlinked items", async () => {
    const s = setup();
    const task = issue();
    s.harness.seed({ issues: [task] });
    await start(s);
    await linkAction(s, task.id, 123);

    s.items.set(123, { state: "Closed", rev: 9 });
    expect((await s.listeners[0]!.onMessage(updatedEvent(123), { messageId: "m", deliveryCount: 1 })).outcome).toBe("complete");
    expect(s.repo.rows.get(task.id)).toMatchObject({ state: "Closed", rev: 9 });

    expect((await s.listeners[0]!.onMessage(updatedEvent(456), { messageId: "m", deliveryCount: 1 })).outcome).toBe("complete");
    expect(s.repo.rows.size).toBe(1);
    // A2 never creates tasks from ADO.
    expect(await s.harness.ctx.issues.list({ companyId: CO })).toHaveLength(1);
  });

  it("never moves a link back to an older revision", async () => {
    const s = setup();
    const task = issue();
    s.harness.seed({ issues: [task] });
    await start(s);
    await linkAction(s, task.id, 123);
    s.items.set(123, { state: "New", rev: 2 });
    await s.listeners[0]!.onMessage(updatedEvent(123), { messageId: "m", deliveryCount: 1 });
    expect(s.repo.rows.get(task.id)).toMatchObject({ state: "Active", rev: 4 });
  });

  it("marks a link whose work item has gone, and clears the mark when it comes back", async () => {
    const s = setup();
    const task = issue();
    s.harness.seed({ issues: [task] });
    await start(s);
    await linkAction(s, task.id, 123);

    s.items.delete(123);
    const deleted = { id: "evt-d", eventType: "workitem.deleted", resource: { id: 123 } };
    expect((await s.listeners[0]!.onMessage(deleted, { messageId: "m", deliveryCount: 1 })).outcome).toBe("complete");
    const marked = s.repo.rows.get(task.id)!;
    expect(marked.missingAt).toEqual(expect.any(String));
    expect(marked.state).toBe("Active");
    expect((await getIssue(s, task.id))!.originKind).toBe(ADO_LINK_ORIGIN_KIND);

    s.items.set(123, { state: "Active", rev: 6 });
    await s.listeners[0]!.onMessage({ id: "evt-r", eventType: "workitem.restored", resource: { id: 123 } }, { messageId: "m", deliveryCount: 1 });
    expect(s.repo.rows.get(task.id)).toMatchObject({ missingAt: null, rev: 6 });
  });
});
