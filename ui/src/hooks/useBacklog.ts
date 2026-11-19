import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginRecord } from "@paperclipai/shared";
import { pluginsApi } from "../api/plugins";
import { backlogApi, BacklogBridgeError } from "../api/backlog";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { ADO_PLUGIN_KEY, type AssignAgentParams, type BacklogData } from "../lib/backlog/contract";

/** How often the backlog is re-read while a full sync runs. */
export const BACKLOG_SYNC_POLL_MS = 2000;
/** Give up waiting for the plugin to report `syncing` after this long. */
const SYNC_START_GRACE_MS = 30_000;
/** Longest gap between polls while the backlog keeps failing to load. */
export const BACKLOG_POLL_MAX_BACKOFF_MS = 30_000;
/** Stop polling after this many failed polls in a row (a stale `syncing` must not poll forever). */
export const BACKLOG_POLL_MAX_ERRORS = 6;

/**
 * The poll interval while a sync runs: every 2 s, doubling after each failed
 * poll up to 30 s, and off after six failures in a row. A success, or the
 * user pressing Sync or Retry, starts it again.
 */
export function backlogPollInterval(wantPoll: boolean, consecutiveErrors: number): number | false {
  if (!wantPoll) return false;
  if (consecutiveErrors <= 0) return BACKLOG_SYNC_POLL_MS;
  if (consecutiveErrors >= BACKLOG_POLL_MAX_ERRORS) return false;
  return Math.min(BACKLOG_SYNC_POLL_MS * 2 ** consecutiveErrors, BACKLOG_POLL_MAX_BACKOFF_MS);
}

interface PollState {
  errorUpdateCount: number;
  errorUpdatedAt: number;
  dataUpdatedAt: number;
}

/** Failed fetches since the last success, or since `baseline` (the error count at the last reset). */
export function consecutiveErrors(state: PollState, baseline: { current: number }): number {
  const lastFetchFailed = state.errorUpdatedAt > state.dataUpdatedAt;
  if (!lastFetchFailed) {
    baseline.current = state.errorUpdateCount;
    return 0;
  }
  return Math.max(0, state.errorUpdateCount - baseline.current);
}

export function findReadyAdoPlugin(plugins: readonly PluginRecord[] | undefined): PluginRecord | null {
  return plugins?.find((plugin) => plugin.pluginKey === ADO_PLUGIN_KEY && plugin.status === "ready") ?? null;
}

/**
 * The installed ADO plugin, when it is ready. Shares the plugin list query
 * with the settings sidebar. A board user who cannot list plugins (403) just
 * gets `null`, so the Backlog stays hidden instead of erroring.
 */
export function useAdoPlugin() {
  const query = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
    staleTime: 60_000,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && (error.status === 401 || error.status === 403)) && failureCount < 2,
  });
  const plugin = findReadyAdoPlugin(query.data);
  return { plugin, pluginId: plugin?.id ?? null, isLoading: query.isLoading, error: query.error };
}

/** Bridge failures from the worker are not retried: the same call fails the same way. */
function retryUnlessBridgeError(failureCount: number, error: unknown) {
  if (error instanceof BacklogBridgeError) return false;
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/**
 * Data `backlog`. Polls while the plugin reports `syncing` (and briefly after
 * a sync is requested, until the plugin reports it), and refreshes every
 * Backlog query once a sync finishes.
 */
export function useBacklog(pluginId: string | null, companyId: string | null) {
  const queryClient = useQueryClient();
  const [awaitingSyncSince, setAwaitingSyncSince] = useState<number | null>(null);
  const errorBaseline = useRef(0);
  const query = useQuery({
    queryKey: queryKeys.backlog.list(companyId ?? "__none__"),
    queryFn: () => backlogApi.getBacklog(pluginId!, companyId!),
    enabled: !!pluginId && !!companyId,
    retry: retryUnlessBridgeError,
    refetchInterval: (q) => {
      const data = q.state.data as BacklogData | undefined;
      return backlogPollInterval(
        data?.syncing === true || awaitingSyncSince !== null,
        consecutiveErrors(q.state, errorBaseline),
      );
    },
  });

  const syncing = query.data?.syncing === true;
  const lastFinishedAt = query.data?.lastSync?.finishedAt ?? null;
  const baselineFinishedAt = useRef<string | null>(null);
  const wasSyncing = useRef(false);

  // Stop waiting once the plugin reports the sync (running or finished), or
  // after the grace period if it never does.
  useEffect(() => {
    if (awaitingSyncSince === null) return;
    if (syncing || lastFinishedAt !== baselineFinishedAt.current) {
      setAwaitingSyncSince(null);
      return;
    }
    const remaining = SYNC_START_GRACE_MS - (Date.now() - awaitingSyncSince);
    const timer = setTimeout(() => setAwaitingSyncSince(null), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [awaitingSyncSince, syncing, lastFinishedAt]);

  // When a sync ends, refresh open work item pages too (titles, states, links).
  useEffect(() => {
    if (wasSyncing.current && !syncing && companyId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.backlog.all(companyId) });
    }
    wasSyncing.current = syncing;
  }, [syncing, companyId, queryClient]);

  /** User action: forget earlier poll failures so polling resumes. */
  const resumePolling = useCallback(() => {
    errorBaseline.current = query.errorUpdateCount;
  }, [query.errorUpdateCount]);

  const sync = useMutation({
    mutationFn: () => backlogApi.syncBacklog(pluginId!, companyId!),
    onMutate: resumePolling,
    onSuccess: (result) => {
      if (!companyId) return;
      if (result.started) {
        baselineFinishedAt.current = lastFinishedAt;
        setAwaitingSyncSince(Date.now());
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.backlog.list(companyId) });
    },
  });

  return {
    query,
    sync,
    /** Fetch again now (the Retry button); also lets a stopped poll resume. */
    retry: () => {
      resumePolling();
      void query.refetch();
    },
    /** True from the click until the plugin reports the sync finished. */
    syncInProgress: syncing || awaitingSyncSince !== null || sync.isPending,
  };
}

/** Data `work-item`: read live from ADO when the page opens. */
export function useWorkItem(pluginId: string | null, companyId: string | null, workItemId: number | null) {
  return useQuery({
    queryKey: queryKeys.backlog.workItem(companyId ?? "__none__", workItemId ?? -1),
    queryFn: () => backlogApi.getWorkItem(pluginId!, companyId!, workItemId!),
    enabled: !!pluginId && !!companyId && workItemId !== null,
    retry: retryUnlessBridgeError,
  });
}

/** Action `assign-agent`; refreshes the backlog, the work item and the linked task. */
export function useAssignAgent(pluginId: string | null, companyId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: AssignAgentParams) => backlogApi.assignAgent(pluginId!, companyId!, params),
    onSuccess: (result) => {
      if (!companyId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.backlog.all(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(result.issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(result.issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(result.issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(result.issueId) });
      if (result.identifier) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(result.identifier) });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });
}

/** The ADO plugin's "changed" signal on its `backlog` stream (no work item content). */
interface BacklogChangedEvent {
  type: "changed";
  reason?: string;
  workItemId?: number;
}

/** How long to wait for more signals before re-reading, so a burst causes one refresh. */
export const BACKLOG_LIVE_DEBOUNCE_MS = 500;

/**
 * Live updates: listens to the plugin's `backlog` stream and re-reads the backlog
 * (and, on a work item page, that work item) when the plugin reports a change. The
 * browser's EventSource reconnects by itself; on reconnect the backlog is re-read once
 * in case a change happened while disconnected.
 */
export function useBacklogLiveUpdates(pluginId: string | null, companyId: string | null, workItemId: number | null = null) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!pluginId || !companyId || typeof EventSource === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let refreshWorkItem = false;
    let wasConnected = false;

    const flush = () => {
      timer = null;
      void queryClient.invalidateQueries({ queryKey: queryKeys.backlog.list(companyId) });
      if (refreshWorkItem && workItemId !== null) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.backlog.workItem(companyId, workItemId) });
      }
      refreshWorkItem = false;
    };
    const schedule = (alsoWorkItem: boolean) => {
      refreshWorkItem ||= alsoWorkItem;
      if (timer === null) timer = setTimeout(flush, BACKLOG_LIVE_DEBOUNCE_MS);
    };

    const params = new URLSearchParams({ companyId });
    const source = new EventSource(
      `/api/plugins/${encodeURIComponent(pluginId)}/bridge/stream/backlog?${params.toString()}`,
      { withCredentials: true },
    );
    source.onopen = () => {
      setConnected(true);
      if (wasConnected) schedule(true);
      wasConnected = true;
    };
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      let event: BacklogChangedEvent;
      try {
        event = JSON.parse(message.data) as BacklogChangedEvent;
      } catch {
        return;
      }
      if (event?.type !== "changed") return;
      // A work item page also re-reads its item (a live ADO read) when the change is
      // about that item, or unspecific (a sync).
      schedule(workItemId !== null && (event.workItemId === undefined || event.workItemId === workItemId));
    };

    return () => {
      if (timer !== null) clearTimeout(timer);
      source.close();
      setConnected(false);
    };
  }, [pluginId, companyId, workItemId, queryClient]);

  return { connected };
}
