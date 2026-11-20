import { AsyncResource } from "node:async_hooks";
import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { AdoClient, AdoError, type WorkItemSummary } from "./ado/client.js";
import { decodeMessageBody, parseAdoEvent, type AdoEvent } from "./ado/events.js";
import { serviceBusListener, type EventListener, type ListenerFactory, type MessageOutcome } from "./ado/servicebus.js";
import { ACTION_KEYS, DATA_KEYS } from "./manifest.js";
import type { PluginDeps } from "./deps.js";
import { registerLinkFeatures, type LinkFeatures } from "./links/index.js";
import type { LinkRepository } from "./links/repository.js";
import { orgName } from "./links/index.js";
import { registerAgentTools, type AgentTools } from "./tools/index.js";
import { registerBacklogFeatures, type BacklogFeatures, type LastFullSync, type SyncStartResult } from "./backlog/index.js";
import { notifyBacklogChanged } from "./backlog/notify.js";
import { createPullRequestNotifier, type PullRequestNotifier } from "./pullrequests/index.js";
import { createWorkItemWatcher, type WorkItemWatcher } from "./watch/index.js";
import { registerSmokeTest } from "./smoke/index.js";
import { createEscalation, DEFAULT_ESCALATION_MODEL } from "./escalation/index.js";
import { registerPullRequestView } from "./pullrequests/view.js";
import { createRouter, parseRoutes, registerQueueView } from "./routing/index.js";
import { createIntake, type Intake } from "./intake/index.js";
import { createCostReporter, type CostReporterOptions } from "./costs/index.js";
import type { WorkItemCacheRepository } from "./backlog/repository.js";

/** How far back the very first catch-up looks when there is no watermark yet. */
const FIRST_SYNC_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Overlap between catch-ups so clock skew between us and ADO cannot open a gap. */
const WATERMARK_OVERLAP_MS = 60 * 1000;
/**
 * A full sync keeps cached rows written less than this long before it started, even
 * when ADO did not return them: ASOF uses our clock, and a few minutes of skew against
 * ADO could otherwise drop an item created just before the sync. Such an item, if it
 * really is gone, is removed by the next full sync.
 */
const FULL_SYNC_DELETE_MARGIN_MS = 5 * 60 * 1000;
/** Where a full sync starts: the beginning of time, so every item of the project is read. */
const FULL_SYNC_SINCE = new Date(0);
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
/** Plugin state key of the last full sync (Backlog view). */
const FULL_SYNC_STATE_KEY = "last-full-sync";
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
  smokeTestAgent?: string;
  builderRoutes?: unknown;
  escalationModel?: string;
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
  /** Work item cache storage (Backlog view); tests pass an in-memory one. */
  workItemCacheRepository?: (ctx: PluginContext) => WorkItemCacheRepository;
  /** Cost report timing (D9); tests pass a synchronous timer. */
  costReporter?: Omit<CostReporterOptions, "deps">;
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
  let backlog: BacklogFeatures | null = null;
  let pullRequests: PullRequestNotifier | null = null;
  let watcher: WorkItemWatcher | null = null;
  let intake: Intake | null = null;

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
   * event, a catch-up, a full sync or a read on the work item page. The Backlog
   * cache row is upserted (never to an older rev), and A2 refreshes linked tasks.
   */
  async function processWorkItem(c: PluginContext, companyId: string, item: WorkItemSummary, source: string): Promise<void> {
    // A full sync handles every item of the project: log those at debug, and one summary line at the end.
    const log = source === "sync:full" ? c.logger.debug.bind(c.logger) : c.logger.info.bind(c.logger);
    log("ADO work item changed", { companyId, source, workItemId: item.id, type: item.type, state: item.state, rev: item.rev });
    // The link as it was before this change: the watcher's starting point for an item it has not seen yet.
    const before = links ? await links.findLinkByWorkItem(companyId, item.id) : null;
    await backlog?.onWorkItemChanged(companyId, item, source);
    await links?.onWorkItemChanged(companyId, item, source);
    // A3: a top-level item tagged for:<Agent> with no linked task yet becomes that agent's task.
    // Not from inside an assignment (it holds the item's lock, and is an assignment already).
    const pickedUp = source === "assign-agent" ? undefined : await intake?.onWorkItem(companyId, item);
    if (pickedUp?.kind === "assigned") c.logger.info("ADO work item picked up", { companyId, workItemId: item.id, agent: pickedUp.agent, source });
    // Linked items always; an item with no linked task only on a live event, for its parent's owner (a sync would replay old changes).
    if (watcher && (before || !source.startsWith("sync:"))) {
      const config = await c.config.get(companyId);
      if (isConfigured(config)) {
        const baseline = before ? { rev: before.rev, syncedAt: before.syncedAt } : null;
        const out = await watcher.onWorkItemChanged(companyId, await adoClient(c, companyId, config), item, baseline);
        if (out.notified.length || out.closed) c.logger.info("Linked task updated from ADO", { companyId, workItemId: item.id, ...out });
      }
    }
    // Catch-ups and full syncs announce once when they finish, not per item.
    if (!source.startsWith("sync:")) notifyBacklogChanged(c, companyId, { reason: "work-item", workItemId: item.id });
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
        // Agents' writes (by the service account) are handled too: one agent's change can be another agent's news.
        // The plugin itself writes nothing to ADO in response, so this cannot loop.
        record.workItem = item;
        await processWorkItem(c, companyId, item, event.target.eventType);
      } else if (event.target.kind === "pullrequest") {
        record.pullRequestId = event.target.pullRequestId;
        const ado = await adoClient(c, companyId, config);
        const out = await pullRequests!.onPullRequestEvent(companyId, ado, event.target);
        c.logger.info("ADO pull request event", { eventType: event.target.eventType, ...out });
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
          await backlog?.onWorkItemMissing(companyId, workItemId).catch((e) =>
            c.logger.warn("Could not drop a missing ADO work item from the cache", { workItemId, error: errorText(e) }),
          );
          notifyBacklogChanged(c, companyId, { reason: "work-item", workItemId });
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

  /**
   * The catch-up (trigger "startup" or "manual") and the full sync (trigger "full",
   * the Backlog view's Sync button) share this loop and the company's one `syncing`
   * flag, so only one of them runs at a time.
   *
   * The catch-up reads items changed since the watermark and moves the watermark
   * forward as it goes. The full sync reads every item from the beginning of time,
   * never moves the watermark backwards while paging, and on success deletes the
   * cached rows ADO did not return and moves the watermark to the start time less
   * the overlap, if that is later: everything changed before the start has then been
   * handled, so the next catch-up need not look further back. A failed full sync
   * deletes nothing and leaves the watermark alone.
   */
  async function runSync(c: PluginContext, companyId: string, trigger: LastSyncRecord["trigger"] | "full"): Promise<LastSyncRecord | null> {
    const rt = runtime(companyId);
    if (rt.syncing) return null;
    rt.syncing = true;
    notifyBacklogChanged(c, companyId, { reason: "sync" });
    const full = trigger === "full";
    const startedAt = now();
    const scope = { scopeKind: "company" as const, scopeId: companyId };
    let since = full ? FULL_SYNC_SINCE : new Date(startedAt - FIRST_SYNC_LOOKBACK_MS);
    const record: LastSyncRecord = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: "",
      trigger: trigger as LastSyncRecord["trigger"],
      since: since.toISOString(),
      changed: 0,
    };
    let removed = 0;
    try {
      const config = await c.config.get(companyId);
      if (!isConfigured(config)) throw new Error("The plugin is not configured for this company");
      const watermark = await c.state.get({ ...scope, stateKey: "sync-watermark" });
      const watermarkDate = typeof watermark === "string" && !Number.isNaN(Date.parse(watermark)) ? new Date(watermark) : null;
      if (!full && watermarkDate) since = watermarkDate;
      record.since = since.toISOString();

      const ado = await adoClient(c, companyId, config);
      // The org and project this run reads; deletion is skipped if the settings change meanwhile.
      const runKey = { org: orgName(config.orgUrl), project: config.project };
      /** IDs the WIQL pages returned: a full sync deletes only cached items not among them. */
      const seen = new Set<number>();
      // Page by change date so a large backlog makes progress and never hits the WIQL limit.
      // Every page reads ADO as it was when the sync started, so an edit made during the
      // sync cannot push the next page's start date forward and skip items. Such edits
      // arrive as live events, and the final watermark (start time less the overlap) covers them.
      const asOf = new Date(startedAt);
      for (;;) {
        const ids = await ado.queryChangedSince(since, SYNC_PAGE_SIZE, asOf);
        const items = await ado.getWorkItemSummaries(ids, asOf);
        if (full) for (const id of ids) seen.add(id);
        for (const item of items) {
          await processWorkItem(c, companyId, item, `sync:${trigger}`);
          record.changed++;
        }
        if (ids.length < SYNC_PAGE_SIZE) break;
        const newest = Math.max(...items.map((i) => Date.parse(i.changedDate ?? "")).filter(Number.isFinite));
        // Step back 1 ms (dates compare to the millisecond) so items sharing the boundary
        // timestamp are not skipped; handling one twice is harmless.
        const next = new Date(newest - 1);
        if (!Number.isFinite(newest) || next <= since) throw new Error("Sync could not move past " + since.toISOString());
        since = next;
        if (!full) await c.state.set({ ...scope, stateKey: "sync-watermark" }, since.toISOString());
      }
      const finalWatermark = new Date(startedAt - WATERMARK_OVERLAP_MS);
      if (full) {
        // Deletion depends on which IDs ADO returned, not on clocks. The write-time guard (with a
        // margin for clock skew between us and ADO) only keeps rows live events wrote around the start.
        const current = await backlog?.projectKey(companyId);
        let gone: number[] = [];
        if (!current || current.org !== runKey.org || current.project !== runKey.project) {
          c.logger.warn("ADO full sync: the organization or project setting changed during the sync; nothing was deleted", { companyId });
        } else {
          const writtenBefore = new Date(startedAt - FULL_SYNC_DELETE_MARGIN_MS).toISOString();
          gone = (await backlog?.removeNotSeen(companyId, runKey, seen, writtenBefore)) ?? [];
        }
        removed = gone.length;
        for (const id of gone) {
          await links?.onWorkItemMissing?.(companyId, id, "sync:full").catch((e) =>
            c.logger.warn("Could not mark ADO link as missing", { workItemId: id, error: errorText(e) }),
          );
        }
      }
      if (!full || !watermarkDate || watermarkDate < finalWatermark) {
        await c.state.set({ ...scope, stateKey: "sync-watermark" }, finalWatermark.toISOString());
      }
      c.logger.info(full ? "ADO full sync finished" : "ADO catch-up finished", { companyId, trigger, changed: record.changed, removed });
    } catch (err) {
      record.error = errorText(err);
      c.logger.error(full ? "ADO full sync failed" : "ADO catch-up failed", { companyId, trigger, error: record.error });
    } finally {
      record.finishedAt = new Date(now()).toISOString();
      rt.syncing = false;
      if (full) {
        const fullRecord: LastFullSync = {
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          trigger,
          changed: record.changed,
          removed,
          ...(record.error ? { error: record.error } : {}),
        };
        await c.state.set({ ...scope, stateKey: FULL_SYNC_STATE_KEY }, fullRecord).catch(() => {});
      } else {
        await c.state.set({ ...scope, stateKey: "last-sync" }, record).catch(() => {});
      }
      // After the sync record is saved, so the page reads the new "last sync" too.
      notifyBacklogChanged(c, companyId, { reason: "sync" });
    }
    return record;
  }

  async function startFullSync(c: PluginContext, companyId: string): Promise<SyncStartResult> {
    if (!isConfigured(await c.config.get(companyId).catch(() => ({})))) {
      return { started: false, reason: "The Azure DevOps plugin is not configured for this company" };
    }
    if (runtime(companyId).syncing) return { started: false, reason: "A sync is already running" };
    // In the background: actions time out after 30 s, and a full sync takes longer.
    void inBackground(() => runSync(c, companyId, "full"));
    return { started: true };
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
      backlog = registerBacklogFeatures(deps, links, {
        repo: options.workItemCacheRepository?.(c),
        processWorkItem: (companyId, item, source) => processWorkItem(c, companyId, item, source),
        startFullSync: (companyId) => startFullSync(c, companyId),
        async syncStatus(companyId) {
          const lastSync = await c.state.get({ scopeKind: "company", scopeId: companyId, stateKey: FULL_SYNC_STATE_KEY });
          return { syncing: runtime(companyId).syncing, lastSync: (lastSync as LastFullSync | null) ?? null };
        },
      });
      // The agents' assignment tool shares the Backlog view's assignment path.
      tools = registerAgentTools(deps, links, backlog.assigner);
      // A10: the smoke-test Epic, created and cleaned up from a dashboard widget.
      registerSmokeTest({
        deps,
        assigner: backlog.assigner,
        async smokeTestAgent(companyId) {
          const config = (await c.config.get(companyId)) as Partial<AdoPluginConfig>;
          const name = typeof config.smokeTestAgent === "string" ? config.smokeTestAgent.trim() : "";
          return name || null;
        },
      });
      // A6: approved work assigned by the builderRoutes setting, with a limit per builder.
      const router = createRouter({
        deps,
        links,
        assigner: backlog.assigner,
        async routes(companyId) {
          return parseRoutes(((await c.config.get(companyId)) as Partial<AdoPluginConfig>).builderRoutes);
        },
      });
      // Pull request completed, abandoned or commented on: tell and wake the agent on the linked task.
      // A5: once merged, the Stories that depend on its work item may start.
      pullRequests = createPullRequestNotifier({
        ctx: c,
        findTaskForWorkItem: links.findTaskForWorkItem,
        async onMerged(companyId, pr) {
          // Logged, not thrown: a retry would post the merge notices again. The next Story or Bug to
          // finish fills the slots too.
          await router.fillSlots(companyId, `pull request #${pr.pullRequestId} merged`).catch((err) =>
            c.logger.warn("ADO routing after a merge failed", { companyId, pullRequestId: pr.pullRequestId, error: errorText(err) }),
          );
        },
      });
      // A6: the "Builder queues" dashboard widget.
      registerQueueView(deps, router);
      // A5: the task's "Pull request" tab.
      registerPullRequestView(deps, links);
      // ADO drives the linked task: it stays open until the work item is final, and others' changes wake its agent.
      intake = createIntake({ deps, links, assigner: backlog.assigner });
      // D9: a struggling builder's Story moves to a stronger model.
      const escalation = createEscalation({
        deps,
        links,
        async escalationModel(companyId) {
          const config = (await c.config.get(companyId)) as Partial<AdoPluginConfig>;
          const model = typeof config.escalationModel === "string" ? config.escalationModel.trim() : DEFAULT_ESCALATION_MODEL;
          return model || null;
        },
      });
      // D9: a Feature's or Epic's cost, written to ADO once its runs have finished.
      const costReporter = createCostReporter({ deps, ...options.costReporter });
      watcher = createWorkItemWatcher({
        ctx: c,
        findTaskForWorkItem: links.findTaskForWorkItem,
        async serviceAccountName(companyId) {
          return (await deps.settings(companyId))?.serviceAccountName ?? null;
        },
        onCompleted: costReporter.onCompleted,
        async onStateChanged(companyId, item) {
          await router.onStateChanged(companyId, item);
          await escalation.onStateChanged(companyId, item).catch((err) =>
            c.logger.warn("ADO model escalation failed", { companyId, workItemId: item.id, error: err instanceof Error ? err.message : String(err) }),
          );
        },
      });
      void costReporter.resume().catch((err) => c.logger.warn("ADO cost reports could not be resumed", { error: err instanceof Error ? err.message : String(err) }));

      // A linked task's status or agent shows on its Backlog row, so tell the page when
      // one changes. Only tasks linked to ADO, and only a "changed" signal is sent.
      c.events.on("issue.updated", async (event) => {
        const issueId = event.entityId;
        if (!issueId || !event.companyId || !links) return;
        const link = await links.findLinkByIssue(event.companyId, issueId).catch(() => null);
        if (!link) return;
        notifyBacklogChanged(c, event.companyId, { reason: "task", workItemId: link.workItemId });
        // A linked task marked done while its work item is still open in ADO goes back to waiting.
        const task = await c.issues.get(issueId, event.companyId).catch(() => null);
        if (task?.status !== "done" || !watcher) return;
        try {
          const config = await c.config.get(event.companyId);
          if (!isConfigured(config)) return;
          const live = await (await adoClient(c, event.companyId, config)).getWorkItemSummary(link.workItemId);
          if (await watcher.onTaskClosed(event.companyId, task, live.state)) {
            c.logger.info("Reopened a task closed before its work item", { companyId: event.companyId, issueId, workItemId: link.workItemId, state: live.state });
          }
        } catch (err) {
          c.logger.warn("Could not check a closed task against ADO", { companyId: event.companyId, issueId, error: errorText(err) });
        }
      });

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
