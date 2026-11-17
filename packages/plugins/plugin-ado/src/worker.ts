import { AsyncResource } from "node:async_hooks";
import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { AdoClient, AdoError, type WorkItemSummary } from "./ado/client.js";
import { decodeMessageBody, parseAdoEvent, type AdoEvent } from "./ado/events.js";
import { serviceBusListener, type EventListener, type ListenerFactory, type MessageOutcome } from "./ado/servicebus.js";
import { ACTION_KEYS, DATA_KEYS } from "./manifest.js";
import type { PluginDeps } from "./deps.js";
import { registerLinkFeatures, type LinkFeatures } from "./links/index.js";
import type { LinkRepository } from "./links/repository.js";
import { registerAgentTools, type AgentTools } from "./tools/index.js";

/** How far back the very first catch-up looks when there is no watermark yet. */
const FIRST_SYNC_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Overlap between catch-ups so clock skew between us and ADO cannot open a gap. */
const WATERMARK_OVERLAP_MS = 60 * 1000;
/** Work items per catch-up page; WIQL refuses more than 20,000 in one query. */
const SYNC_PAGE_SIZE = 5000;
/**
 * The PAT is kept in memory only, for at most this long, because the host
 * limits secret lookups per minute and a burst of events would exceed it.
 * It is never logged or written to state.
 */
const PAT_CACHE_MS = 60 * 1000;
/** Wait before handing a failed message back: 10 s per attempt, capped below the 1-minute lock. */
const RETRY_DELAY_STEP_MS = 10_000;
const RETRY_DELAY_MAX_MS = 50_000;
/** Attempts to list companies when restoring listeners after a crash restart. */
const RECOVERY_ATTEMPTS = 5;

/**
 * Host calls made inside a host invocation (configChanged, an action) carry that
 * invocation's id, and the host refuses them once the invocation has returned.
 * Long-lived work (the listener, a catch-up) must therefore start outside any
 * invocation. This resource is created at module load, when there is none, and
 * work run through it carries no invocation id, so the host treats it as
 * background work for the plugin's configured companies.
 */
const background = new AsyncResource("chimera-ado-background");
function inBackground<T>(fn: () => Promise<T>): Promise<T> {
  return background.runInAsyncScope(fn);
}

export interface AdoPluginConfig {
  orgUrl: string;
  project: string;
  pat: unknown;
  serviceBusConnection: unknown;
  queueName?: string;
  serviceAccountName?: string;
}

export interface LastEventRecord {
  at: string;
  eventType: string;
  workItem?: WorkItemSummary;
  pullRequestId?: number;
}

export interface LastSyncRecord {
  startedAt: string;
  finishedAt: string;
  trigger: "startup" | "manual";
  since: string;
  changed: number;
  error?: string;
}

export type ListenerStatus = "not_configured" | "starting" | "listening" | "error";

export interface AdoStatus {
  configured: boolean;
  listener: ListenerStatus;
  listenerError: string | null;
  syncing: boolean;
  lastSync: LastSyncRecord | null;
  lastEvent: LastEventRecord | null;
}

interface CompanyRuntime {
  listener: EventListener | null;
  status: ListenerStatus;
  error: string | null;
  syncing: boolean;
  /** Bumped on every stop; callbacks from an older listener check it and do nothing. */
  generation: number;
  /** Start/stop for one company run one after another. */
  chain: Promise<void>;
  /** Settings have been applied at least once in this worker's life (by the host or by recovery). */
  applied: boolean;
  pat?: { value: string; expires: number; generation: number };
}

function isConfigured(c: Record<string, unknown>): c is Record<string, unknown> & AdoPluginConfig {
  return (
    typeof c.orgUrl === "string" && !!c.orgUrl &&
    typeof c.project === "string" && !!c.project &&
    !!c.pat && !!c.serviceBusConnection
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface AdoPluginOptions {
  listenerFactory?: ListenerFactory;
  now?: () => number;
  /** Retry delay for failed messages; tests set this to zero. */
  retryDelayMs?: (deliveryCount: number) => number;
  /** Wait between attempts to list companies after a restart; tests set this to zero. */
  recoveryDelayMs?: number;
  /** Link storage; tests pass an in-memory one because the test harness has no database. */
  linkRepository?: (ctx: PluginContext) => LinkRepository;
}

export function createAdoPlugin(options: AdoPluginOptions = {}) {
  const listenerFactory = options.listenerFactory ?? serviceBusListener;
  const now = options.now ?? Date.now;
  const retryDelayMs =
    options.retryDelayMs ?? ((n: number) => Math.min(Math.max(n, 1) * RETRY_DELAY_STEP_MS, RETRY_DELAY_MAX_MS));
  const recoveryDelayMs = options.recoveryDelayMs ?? 3000;
  const runtimes = new Map<string, CompanyRuntime>();
  /** Companies that already had their startup catch-up in this worker's life. */
  const caughtUp = new Set<string>();
  let ctx: PluginContext | null = null;
  let links: LinkFeatures | null = null;
  let tools: AgentTools | null = null;

  function runtime(companyId: string): CompanyRuntime {
    let rt = runtimes.get(companyId);
    if (!rt) {
      rt = { listener: null, status: "not_configured", error: null, syncing: false, generation: 0, chain: Promise.resolve(), applied: false };
      runtimes.set(companyId, rt);
    }
    return rt;
  }

  /** Queue a start/stop step for one company behind any step already running. */
  function serialize(companyId: string, step: () => Promise<void>): Promise<void> {
    const rt = runtime(companyId);
    const next = rt.chain.then(step, step);
    rt.chain = next.catch(() => {});
    return next;
  }

  async function adoClient(c: PluginContext, companyId: string, config: AdoPluginConfig): Promise<AdoClient> {
    const rt = runtime(companyId);
    const generation = rt.generation;
    let pat = rt.pat && rt.pat.generation === generation && rt.pat.expires >= now() ? rt.pat.value : null;
    if (!pat) {
      pat = await c.secrets.resolve(config.pat as never, { companyId, configPath: "pat" });
      // A stop during the lookup means these settings are stale: use the value once, do not cache it.
      if (rt.generation === generation) rt.pat = { value: pat, expires: now() + PAT_CACHE_MS, generation };
    }
    return new AdoClient({
      orgUrl: config.orgUrl,
      project: config.project,
      pat,
      fetch: (url, init) => c.http.fetch(url, init),
    });
  }

  /**
   * The one place a changed work item is handled, whether it came from a live
   * event or from a catch-up. A2 refreshes linked tasks here; A3 adds creating them.
   */
  async function processWorkItem(c: PluginContext, companyId: string, item: WorkItemSummary, source: string): Promise<void> {
    c.logger.info("ADO work item changed", { companyId, source, workItemId: item.id, type: item.type, state: item.state, rev: item.rev });
    await links?.onWorkItemChanged(companyId, item, source);
  }

  function makeDeps(c: PluginContext): PluginDeps {
    return {
      ctx: c,
      now,
      async settings(companyId) {
        const config = await c.config.get(companyId);
        if (!isConfigured(config)) return null;
        return { orgUrl: config.orgUrl, project: config.project, serviceAccountName: config.serviceAccountName };
      },
      async adoClient(companyId) {
        const config = await c.config.get(companyId);
        if (!isConfigured(config)) throw new Error("The Azure DevOps plugin is not configured for this company");
        return adoClient(c, companyId, config);
      },
    };
  }

  async function handleEvent(
    c: PluginContext,
    companyId: string,
    config: AdoPluginConfig,
    body: unknown,
    info: { messageId: string; deliveryCount: number },
  ): Promise<{ outcome: MessageOutcome; reason?: string; delayMs?: number }> {
    let event: AdoEvent;
    try {
      event = parseAdoEvent(decodeMessageBody(body));
    } catch (err) {
      c.logger.warn("Unreadable ADO message moved to the dead-letter queue", { messageId: info.messageId, error: errorText(err) });
      return { outcome: "deadletter", reason: "unreadable" };
    }

    try {
      const record: LastEventRecord = { at: new Date(now()).toISOString(), eventType: event.target.eventType };
      if (event.target.kind === "workitem") {
        const ado = await adoClient(c, companyId, config);
        const item = await ado.getWorkItemSummary(event.target.workItemId);
        // Our own write echoing back (loop prevention for A4).
        if (config.serviceAccountName && item.changedBy === config.serviceAccountName) return { outcome: "complete" };
        record.workItem = item;
        await processWorkItem(c, companyId, item, event.target.eventType);
      } else if (event.target.kind === "pullrequest") {
        record.pullRequestId = event.target.pullRequestId;
        c.logger.info("ADO pull request event", { eventType: event.target.eventType, pullRequestId: event.target.pullRequestId });
        // A5 hook point.
      } else {
        // Also hit if a payload carries no usable id: worth a warning, not silence.
        c.logger.warn("Ignoring ADO event", { eventType: event.target.eventType, eventId: event.eventId });
      }
      await c.state.set({ scopeKind: "company", scopeId: companyId, stateKey: "last-event" }, record);
      return { outcome: "complete" };
    } catch (err) {
      if (err instanceof AdoError && err.status === 404) {
        // Deleted, moved or not visible to the service account: retrying will not help.
        c.logger.warn("ADO item not found; dropping event", { eventId: event.eventId, eventType: event.target.eventType });
        if (event.target.kind === "workitem") {
          // A linked task keeps its link, marked as missing, so the loss is visible.
          const workItemId = event.target.workItemId;
          await links?.onWorkItemMissing?.(companyId, workItemId, event.target.eventType).catch((e) =>
            c.logger.warn("Could not mark ADO link as missing", { workItemId, error: errorText(e) }),
          );
        }
        return { outcome: "complete" };
      }
      if (err instanceof AdoError && err.status === 401) runtime(companyId).pat = undefined;
      // Service Bus redelivers; after the queue's max delivery count it dead-letters the message itself.
      c.logger.error("ADO event failed; Service Bus will redeliver it", {
        eventId: event.eventId,
        eventType: event.target.eventType,
        deliveryCount: info.deliveryCount,
        error: errorText(err),
      });
      return { outcome: "abandon", delayMs: retryDelayMs(info.deliveryCount) };
    }
  }

  async function stopListener(companyId: string): Promise<void> {
    const rt = runtime(companyId);
    rt.generation++;
    const listener = rt.listener;
    rt.listener = null;
    rt.status = "not_configured";
    rt.error = null;
    rt.pat = undefined;
    if (listener) await listener.close();
  }

  async function startListener(c: PluginContext, companyId: string, config: AdoPluginConfig): Promise<void> {
    const rt = runtime(companyId);
    const generation = rt.generation;
    const current = () => rt.generation === generation;
    rt.status = "starting";
    try {
      const connection = await c.secrets.resolve(config.serviceBusConnection as never, {
        companyId,
        configPath: "serviceBusConnection",
      });
      if (!current()) return;
      rt.listener = listenerFactory(connection, config.queueName || "ado-events", {
        onMessage: async (body, info) => {
          const result = await handleEvent(c, companyId, config, body, info);
          if (current() && result.outcome !== "abandon") {
            rt.status = "listening";
            rt.error = null;
          }
          return result;
        },
        onError: (err) => {
          if (!current()) return;
          // The SDK keeps retrying the connection; surface the problem until a message gets through.
          rt.status = "error";
          rt.error = errorText(err);
          c.logger.warn("ADO Service Bus listener error", { companyId, error: rt.error });
        },
      });
      if (current() && rt.status === "starting") rt.status = "listening";
      c.logger.info("ADO Service Bus listener started", { companyId });
    } catch (err) {
      if (!current()) return;
      rt.status = "error";
      rt.error = errorText(err);
      c.logger.error("ADO Service Bus listener failed to start", { companyId, error: rt.error });
    }
  }

  /**
   * Stop the company's listener, start a new one if the settings are complete,
   * and run the first catch-up. Must run inside serialize() for that company.
   */
  async function applyConfigNow(c: PluginContext, companyId: string, config: Record<string, unknown>): Promise<void> {
    runtime(companyId).applied = true;
    await stopListener(companyId);
    if (!isConfigured(config)) return;
    await startListener(c, companyId, config);
    if (!caughtUp.has(companyId)) {
      caughtUp.add(companyId);
      // A failed first catch-up runs again on the next settings save (for example after fixing the PAT).
      void runSync(c, companyId, "startup").then((r) => {
        if (r?.error) caughtUp.delete(companyId);
      });
    }
  }

  function applyConfig(c: PluginContext, companyId: string, config: Record<string, unknown>): Promise<void> {
    return serialize(companyId, () => applyConfigNow(c, companyId, config));
  }

  async function runSync(c: PluginContext, companyId: string, trigger: LastSyncRecord["trigger"]): Promise<LastSyncRecord | null> {
    const rt = runtime(companyId);
    if (rt.syncing) return null;
    rt.syncing = true;
    const startedAt = now();
    const scope = { scopeKind: "company" as const, scopeId: companyId };
    let since = new Date(startedAt - FIRST_SYNC_LOOKBACK_MS);
    const record: LastSyncRecord = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: "",
      trigger,
      since: since.toISOString(),
      changed: 0,
    };
    try {
      const config = await c.config.get(companyId);
      if (!isConfigured(config)) throw new Error("The plugin is not configured for this company");
      const watermark = await c.state.get({ ...scope, stateKey: "sync-watermark" });
      if (typeof watermark === "string" && !Number.isNaN(Date.parse(watermark))) since = new Date(watermark);
      record.since = since.toISOString();

      const ado = await adoClient(c, companyId, config);
      // Page by change date so a large backlog makes progress and never hits the WIQL limit.
      // Every page reads ADO as it was when the catch-up started, so an edit made during the
      // catch-up cannot push the next page's start date forward and skip items. Such edits
      // arrive as live events, and the final watermark (start time less the overlap) covers them.
      const asOf = new Date(startedAt);
      for (;;) {
        const ids = await ado.queryChangedSince(since, SYNC_PAGE_SIZE, asOf);
        const items = await ado.getWorkItemSummaries(ids, asOf);
        for (const item of items) {
          await processWorkItem(c, companyId, item, `sync:${trigger}`);
          record.changed++;
        }
        if (ids.length < SYNC_PAGE_SIZE) break;
        const newest = Math.max(...items.map((i) => Date.parse(i.changedDate ?? "")).filter(Number.isFinite));
        // Step back 1 ms (dates compare to the millisecond) so items sharing the boundary
        // timestamp are not skipped; handling one twice is harmless.
        const next = new Date(newest - 1);
        if (!Number.isFinite(newest) || next <= since) throw new Error("Catch-up could not move past " + since.toISOString());
        since = next;
        await c.state.set({ ...scope, stateKey: "sync-watermark" }, since.toISOString());
      }
      await c.state.set({ ...scope, stateKey: "sync-watermark" }, new Date(startedAt - WATERMARK_OVERLAP_MS).toISOString());
      c.logger.info("ADO catch-up finished", { companyId, trigger, changed: record.changed });
    } catch (err) {
      record.error = errorText(err);
      c.logger.error("ADO catch-up failed", { companyId, trigger, error: record.error });
    } finally {
      record.finishedAt = new Date(now()).toISOString();
      rt.syncing = false;
      await c.state.set({ ...scope, stateKey: "last-sync" }, record).catch(() => {});
    }
    return record;
  }

  /**
   * The host replays stored settings when it loads the plugin, but not when it
   * restarts a crashed worker. So on every start, look up the settings of each
   * company the plugin may act for and apply them if the host has not.
   */
  async function recoverAfterRestart(c: PluginContext): Promise<void> {
    // Listing names no company, so the host refuses it while any other host call
    // to this worker is in flight (likely at startup). Try a few times.
    let companies: Array<{ id: string }> | null = null;
    for (let attempt = 1; attempt <= RECOVERY_ATTEMPTS && !companies; attempt++) {
      try {
        companies = await c.companies.list();
      } catch (err) {
        if (attempt === RECOVERY_ATTEMPTS) {
          c.logger.warn("Could not list companies to restore ADO listeners; save the settings to restart them", { error: errorText(err) });
          return;
        }
        await new Promise((r) => setTimeout(r, recoveryDelayMs));
      }
    }
    for (const { id } of companies ?? []) {
      if (runtime(id).applied) continue;
      let config: Record<string, unknown>;
      try {
        config = await c.config.get(id);
      } catch {
        continue; // No saved settings for this company, so the host does not let us act for it.
      }
      // Skip if the host delivered the settings while we were looking.
      await serialize(id, async () => {
        if (runtime(id).applied) return;
        await applyConfigNow(c, id, config);
      }).catch(() => {});
    }
  }

  function companyIdFrom(params: Record<string, unknown>): string {
    const id = params.companyId;
    if (typeof id !== "string" || !id) throw new Error("companyId is required");
    return id;
  }

  return definePlugin({
    multiCompanyConfig: true,

    async setup(c) {
      ctx = c;
      const deps = makeDeps(c);
      links = registerLinkFeatures(deps, options.linkRepository?.(c));
      tools = registerAgentTools(deps, links);

      c.data.register(DATA_KEYS.status, async (params): Promise<AdoStatus> => {
        const companyId = companyIdFrom(params);
        const rt = runtime(companyId);
        const scope = { scopeKind: "company" as const, scopeId: companyId };
        return {
          configured: rt.status !== "not_configured",
          listener: rt.status,
          listenerError: rt.error,
          syncing: rt.syncing,
          lastSync: ((await c.state.get({ ...scope, stateKey: "last-sync" })) as LastSyncRecord | null) ?? null,
          lastEvent: ((await c.state.get({ ...scope, stateKey: "last-event" })) as LastEventRecord | null) ?? null,
        };
      });

      // Starts the catch-up in the background and returns at once: actions time out
      // after 30 s, and a catch-up can take longer. The widget refreshes until it ends.
      c.actions.register(ACTION_KEYS.syncNow, async (params) => {
        const companyId = companyIdFrom(params);
        if (runtime(companyId).syncing) return { started: false, reason: "A sync is already running" };
        void inBackground(() => runSync(c, companyId, "manual"));
        return { started: true };
      });

      void inBackground(() => recoverAfterRestart(c));
    },

    /**
     * The host delivers each company's stored settings when it loads the plugin,
     * and again whenever they are saved.
     */
    async onConfigChanged(newConfig, context) {
      const companyId = context?.companyId;
      const c = ctx;
      if (!c || !companyId) return;
      await tools?.onConfigChanged(companyId, newConfig);
      // Started outside this invocation so the listener and catch-up keep working after it returns.
      await inBackground(() => applyConfig(c, companyId, newConfig));
    },

    async onShutdown() {
      await Promise.all([...runtimes.keys()].map((id) => serialize(id, () => stopListener(id))));
    },

    async onHealth() {
      const failing = [...runtimes.entries()].filter(([, rt]) => rt.status === "error");
      if (failing.length > 0) {
        return { status: "degraded", message: `Service Bus listener error: ${failing[0]![1].error}` };
      }
      const listening = [...runtimes.values()].filter((rt) => rt.status === "listening").length;
      return { status: "ok", message: `Listening for ADO events for ${listening} company(ies)` };
    },
  });
}

const plugin = createAdoPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
