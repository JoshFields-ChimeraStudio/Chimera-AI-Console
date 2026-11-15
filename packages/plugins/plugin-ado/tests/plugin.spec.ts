import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { ACTION_KEYS, DATA_KEYS } from "../src/manifest.js";
import { createAdoPlugin, type AdoStatus, type LastSyncRecord } from "../src/worker.js";
import { AdoClient, retryAfterMs } from "../src/ado/client.js";
import { decodeMessageBody, decodeMessageText, parseAdoEvent } from "../src/ado/events.js";
import type { ListenerHandlers } from "../src/ado/servicebus.js";

const ORG = "https://dev.azure.com/ChimeraStudioSoftware";
const CO = "co-1";
const CONFIG = {
  orgUrl: ORG,
  project: "AI Testing",
  pat: { type: "secret_ref", secretId: "pat" },
  serviceBusConnection: { type: "secret_ref", secretId: "sb" },
  serviceAccountName: "AI Service",
};

const workItemUpdated = {
  id: "evt-1",
  eventType: "workitem.updated",
  resource: { id: 7, workItemId: 42, url: "https://x" },
  resourceContainers: { project: { id: "proj-1" } },
  createdDate: "2026-11-14T00:00:00Z",
};

function adoItem(id: number, changedBy = "Josh") {
  return {
    id,
    rev: 3,
    url: "u",
    fields: { "System.WorkItemType": "User Story", "System.State": "Active", "System.Title": `Item ${id}`, "System.ChangedBy": { displayName: changedBy } },
  };
}

describe("event decoding", () => {
  it("accepts plain and base64-encoded JSON, as text, bytes or an object", () => {
    const json = JSON.stringify(workItemUpdated);
    expect(decodeMessageText(json)).toEqual(workItemUpdated);
    expect(decodeMessageText(Buffer.from(json).toString("base64"))).toEqual(workItemUpdated);
    expect(decodeMessageBody(new TextEncoder().encode(json))).toEqual(workItemUpdated);
    expect(decodeMessageBody(Buffer.from(json))).toEqual(workItemUpdated);
    expect(decodeMessageBody(workItemUpdated)).toEqual(workItemUpdated);
    expect(() => decodeMessageText("not json")).toThrow();
    expect(() => decodeMessageBody(undefined)).toThrow();
  });

  it("uses workItemId (not the update id) on workitem.updated", () => {
    const e = parseAdoEvent(workItemUpdated);
    expect(e.target).toEqual({ kind: "workitem", eventType: "workitem.updated", workItemId: 42 });
    expect(e.projectId).toBe("proj-1");
  });

  it("reads the work item id from resource.id on workitem.created", () => {
    expect(parseAdoEvent({ id: "e", eventType: "workitem.created", resource: { id: 9 } }).target).toMatchObject({ kind: "workitem", workItemId: 9 });
  });

  it("reads pull request ids, including from comment events", () => {
    expect(parseAdoEvent({ eventType: "git.pullrequest.updated", resource: { pullRequestId: 5, repository: { id: "r" } } }).target)
      .toEqual({ kind: "pullrequest", eventType: "git.pullrequest.updated", pullRequestId: 5, repositoryId: "r" });
    expect(parseAdoEvent({ eventType: "ms.vss-code.git-pullrequest-comment-event", resource: { pullRequest: { pullRequestId: 6 } } }).target)
      .toMatchObject({ kind: "pullrequest", pullRequestId: 6 });
  });

  it("falls back to the resource URL when a payload has no id fields", () => {
    expect(parseAdoEvent({ eventType: "workitem.updated", resource: { url: "https://dev.azure.com/o/_apis/wit/workItems/42/updates/7" } }).target)
      .toMatchObject({ kind: "workitem", workItemId: 42 });
    expect(parseAdoEvent({ eventType: "git.pullrequest.created", resource: { url: "https://dev.azure.com/o/_apis/git/repositories/r/pullRequests/12" } }).target)
      .toMatchObject({ kind: "pullrequest", pullRequestId: 12 });
  });
});

describe("manifest", () => {
  it("declares secret fields without a type so the stored secret_ref object validates", () => {
    const props = (manifest.instanceConfigSchema as any).properties;
    expect(props.pat).not.toHaveProperty("type");
    expect(props.serviceBusConnection).not.toHaveProperty("type");
  });

  it("has no scheduled jobs: catch-up runs on startup and on demand only", () => {
    expect(manifest.jobs ?? []).toEqual([]);
  });
});

describe("ADO client", () => {
  it("parses Retry-After as seconds or an HTTP date, clamped", () => {
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs(null)).toBe(5000);
    expect(retryAfterMs("999")).toBe(30000);
    expect(retryAfterMs("Sat, 14 Nov 2026 00:00:10 GMT", Date.parse("2026-11-14T00:00:00Z"))).toBe(10000);
  });

  it("retries once on 429 and never leaks the PAT in errors", async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const responses = [new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }), new Response("nope", { status: 401 })];
    const sleep = vi.fn(async () => {});
    const client = new AdoClient({
      orgUrl: `${ORG}/`,
      project: "AI Testing",
      pat: "secret-pat",
      sleep,
      fetch: async (url, init) => {
        calls.push({ url, auth: (init?.headers as Record<string, string>).Authorization });
        return responses.shift()!;
      },
    });
    const err = await client.getWorkItem(1).catch((e) => e);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(calls[0]!.url).toBe(`${ORG}/AI%20Testing/_apis/wit/workitems/1?$expand=relations&api-version=7.1`);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(":secret-pat").toString("base64")}`);
    expect(String(err.message)).toContain("401");
    expect(String(err.message)).not.toContain("secret-pat");
  });

  it("queries changed items with time precision and batches summaries by 200", async () => {
    const bodies: any[] = [];
    const urls: string[] = [];
    const client = new AdoClient({
      orgUrl: ORG,
      project: "AI Testing",
      pat: "p",
      fetch: async (url, init) => {
        urls.push(url);
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (url.includes("/wiql")) return Response.json({ workItems: Array.from({ length: 250 }, (_, i) => ({ id: i + 1 })) });
        return Response.json({ value: [...body.ids.map((id: number) => adoItem(id)), null] });
      },
    });
    const ids = await client.queryChangedSince(new Date("2026-11-01T00:00:00Z"));
    expect(urls[0]).toContain("/_apis/wit/wiql?timePrecision=true");
    expect(bodies[0].query).toContain("[System.ChangedDate] > '2026-11-01T00:00:00.000Z'");
    const items = await client.getWorkItemSummaries(ids);
    expect(bodies[1].ids).toHaveLength(200);
    expect(bodies[2].ids).toHaveLength(50);
    expect(items).toHaveLength(250);
  });
});

describe("plugin runtime", () => {
  afterEach(() => vi.unstubAllGlobals());

  interface FakeAdo {
    wiqlIds?: number[];
    missing?: number[];
    failing?: number[];
    changedBy?: string;
  }

  function setup(ado: FakeAdo = {}) {
    const listeners: Array<{ connection: string; queue: string; handlers: ListenerHandlers; closed: boolean }> = [];
    const plugin = createAdoPlugin({
      recoveryDelayMs: 0,
      listenerFactory: (connection, queue, handlers) => {
        const l = { connection, queue, handlers, closed: false };
        listeners.push(l);
        return { close: async () => void (l.closed = true) };
      },
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/wiql")) return Response.json({ workItems: (ado.wiqlIds ?? []).map((id) => ({ id })) });
      if (url.includes("/workitemsbatch")) {
        const { ids } = JSON.parse(String(init?.body));
        return Response.json({ value: ids.map((id: number) => adoItem(id)) });
      }
      const m = url.match(/\/workitems\/(\d+)/);
      if (m) {
        const id = Number(m[1]);
        if (ado.missing?.includes(id)) return new Response("missing", { status: 404 });
        if (ado.failing?.includes(id)) return new Response("boom", { status: 500 });
        return Response.json(adoItem(id, ado.changedBy));
      }
      return new Response("unexpected", { status: 500 });
    });
    const harness = createTestHarness({ manifest, config: CONFIG });
    (harness.ctx.secrets as { resolve: unknown }).resolve = async (ref: { secretId: string }) =>
      ref.secretId === "pat" ? "pat-value" : "Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=listen;SharedAccessKey=k";
    return { plugin, harness, listeners, requests };
  }

  async function start(s: ReturnType<typeof setup>) {
    await s.plugin.definition.setup(s.harness.ctx);
    await s.plugin.definition.onConfigChanged!(CONFIG, { companyId: CO });
    await vi.waitFor(async () => {
      const status = await s.harness.getData<AdoStatus>(DATA_KEYS.status, { companyId: CO });
      expect(status.syncing).toBe(false);
      expect(status.lastSync).not.toBeNull();
    });
  }

  it("starts a listener on the delivered config and runs one catch-up at startup", async () => {
    const s = setup({ wiqlIds: [5, 6] });
    await start(s);
    expect(s.listeners).toHaveLength(1);
    expect(s.listeners[0]!.queue).toBe("ado-events");
    const status = await s.harness.getData<AdoStatus>(DATA_KEYS.status, { companyId: CO });
    expect(status.listener).toBe("listening");
    expect(status.lastSync).toMatchObject({ trigger: "startup", changed: 2 });
    expect(status.lastSync!.error).toBeUndefined();
    expect(s.harness.getState({ scopeKind: "company", scopeId: CO, stateKey: "sync-watermark" })).toEqual(expect.any(String));

    // A later save restarts the listener but does not repeat the startup catch-up.
    const wiqlCalls = s.requests.filter((r) => r.includes("/wiql")).length;
    await s.plugin.definition.onConfigChanged!(CONFIG, { companyId: CO });
    expect(s.listeners[0]!.closed).toBe(true);
    expect(s.listeners).toHaveLength(2);
    expect(s.requests.filter((r) => r.includes("/wiql")).length).toBe(wiqlCalls);
  });

  it("does nothing until the company's settings are complete", async () => {
    const s = setup();
    await s.plugin.definition.setup(s.harness.ctx);
    await s.plugin.definition.onConfigChanged!({ orgUrl: ORG }, { companyId: CO });
    expect(s.listeners).toHaveLength(0);
    expect(s.requests).toHaveLength(0);
  });

  it("Sync now starts a catch-up from the watermark in the background", async () => {
    const s = setup({ wiqlIds: [] });
    await start(s);
    const watermark = s.harness.getState({ scopeKind: "company", scopeId: CO, stateKey: "sync-watermark" }) as string;
    const res = await s.harness.performAction<{ started: boolean }>(ACTION_KEYS.syncNow, { companyId: CO });
    expect(res.started).toBe(true);
    await vi.waitFor(() => {
      const last = s.harness.getState({ scopeKind: "company", scopeId: CO, stateKey: "last-sync" }) as LastSyncRecord;
      expect(last).toMatchObject({ trigger: "manual", since: watermark, changed: 0 });
    });
  });

  it("pages a large catch-up by change date and moves the watermark as it goes", async () => {
    const s = setup();
    let calls = 0;
    const wiqlBodies: any[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/wiql")) {
        calls++;
        wiqlBodies.push(JSON.parse(String(init?.body)));
        expect(url).toContain("$top=5000");
        const n = calls === 1 ? 5000 : 3;
        return Response.json({ workItems: Array.from({ length: n }, (_, i) => ({ id: calls * 10000 + i })) });
      }
      if (url.includes("/workitemsbatch")) {
        const { ids, asOf } = JSON.parse(String(init?.body));
        expect(asOf).toEqual(expect.any(String));
        const offset = ids[0] % 10000;
        return Response.json({
          value: ids.map((id: number, j: number) => ({
            ...adoItem(id),
            fields: { ...adoItem(id).fields, "System.ChangedDate": new Date(Date.parse("2026-11-10T00:00:00Z") + (offset + j) * 1000).toISOString() },
          })),
        });
      }
      return realFetch(input, init);
    });
    await start(s);
    const last = s.harness.getState({ scopeKind: "company", scopeId: CO, stateKey: "last-sync" }) as LastSyncRecord;
    expect(calls).toBe(2);
    expect(last.changed).toBe(5003);
    expect(wiqlBodies[0].query).toMatch(/ASOF '\d{4}-/);
    expect(wiqlBodies[1].query).toContain("> '2026-11-10T01:23:18.999Z'");
    expect(last.error).toBeUndefined();
  });

  it("restores listeners after a crash restart, when the host does not replay settings", async () => {
    const s = setup({ wiqlIds: [] });
    s.harness.seed({ companies: [{ id: CO, name: "Chimera" } as never, { id: "co-2", name: "Other" } as never] });
    const realGet = s.harness.ctx.config.get.bind(s.harness.ctx.config);
    (s.harness.ctx.config as { get: unknown }).get = async (id: string) => {
      if (id !== CO) throw new Error("company context is required");
      return realGet(id);
    };
    await s.plugin.definition.setup(s.harness.ctx);
    await vi.waitFor(() => expect(s.listeners).toHaveLength(1));
    const status = await s.harness.getData<AdoStatus>(DATA_KEYS.status, { companyId: CO });
    expect(status.listener).toBe("listening");
  });

  it("two quick saves leave exactly one open listener", async () => {
    const s = setup();
    await s.plugin.definition.setup(s.harness.ctx);
    await Promise.all([
      s.plugin.definition.onConfigChanged!(CONFIG, { companyId: CO }),
      s.plugin.definition.onConfigChanged!({ ...CONFIG, queueName: "other" }, { companyId: CO }),
    ]);
    expect(s.listeners.filter((l) => !l.closed)).toHaveLength(1);
    expect(s.listeners.find((l) => !l.closed)!.queue).toBe("other");
  });

  it("ignores errors from a listener that has been replaced", async () => {
    const s = setup();
    await start(s);
    const old = s.listeners[0]!;
    await s.plugin.definition.onConfigChanged!(CONFIG, { companyId: CO });
    old.handlers.onError(new Error("stale"));
    expect((await s.harness.getData<AdoStatus>(DATA_KEYS.status, { companyId: CO })).listener).toBe("listening");
  });

  it("handles a live event: fetches the item, records it and completes the message", async () => {
    const s = setup();
    await start(s);
    const result = await s.listeners[0]!.handlers.onMessage(Buffer.from(JSON.stringify(workItemUpdated)), { messageId: "m1", deliveryCount: 1 });
    expect(result.outcome).toBe("complete");
    const last = s.harness.getState({ scopeKind: "company", scopeId: CO, stateKey: "last-event" }) as any;
    expect(last.workItem).toMatchObject({ id: 42, type: "User Story", state: "Active", changedBy: "Josh" });
    expect(last.workItem.webUrl).toBe(`${ORG}/AI%20Testing/_workitems/edit/42`);
  });

  it("dead-letters unreadable messages, drops missing items and abandons failures for redelivery", async () => {
    const s = setup({ missing: [404], failing: [500] });
    await start(s);
    const h = s.listeners[0]!.handlers;
    const info = { messageId: "m", deliveryCount: 1 };
    expect((await h.onMessage("garbage", info)).outcome).toBe("deadletter");
    expect((await h.onMessage({ ...workItemUpdated, resource: { workItemId: 404 } }, info)).outcome).toBe("complete");
    const failed = await h.onMessage({ ...workItemUpdated, resource: { workItemId: 500 } }, { messageId: "m", deliveryCount: 3 });
    expect(failed.outcome).toBe("abandon");
    expect(failed.delayMs).toBe(30_000);
    expect((await h.onMessage({ ...workItemUpdated, resource: { workItemId: 500 } }, { messageId: "m", deliveryCount: 9 })).delayMs).toBe(50_000);
  });

  it("ignores events caused by the service account itself", async () => {
    const s = setup({ changedBy: "AI Service" });
    await start(s);
    const before = s.harness.getState({ scopeKind: "company", scopeId: CO, stateKey: "last-event" });
    expect((await s.listeners[0]!.handlers.onMessage(workItemUpdated, { messageId: "m", deliveryCount: 1 })).outcome).toBe("complete");
    expect(s.harness.getState({ scopeKind: "company", scopeId: CO, stateKey: "last-event" })).toEqual(before);
  });

  it("shows listener errors in status and health until a message gets through", async () => {
    const s = setup();
    await start(s);
    s.listeners[0]!.handlers.onError(new Error("Unauthorized"));
    expect((await s.harness.getData<AdoStatus>(DATA_KEYS.status, { companyId: CO })).listener).toBe("error");
    expect((await s.plugin.definition.onHealth!()).status).toBe("degraded");
    await s.listeners[0]!.handlers.onMessage(workItemUpdated, { messageId: "m", deliveryCount: 1 });
    expect((await s.harness.getData<AdoStatus>(DATA_KEYS.status, { companyId: CO })).listener).toBe("listening");
  });

  it("closes listeners on shutdown", async () => {
    const s = setup();
    await start(s);
    await s.plugin.definition.onShutdown!();
    expect(s.listeners[0]!.closed).toBe(true);
  });
});
