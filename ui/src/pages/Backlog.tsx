import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListTree, Loader2, RefreshCw, RotateCw } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { agentsApi } from "../api/agents";
import { isPluginUnavailableError } from "../api/backlog";
import { describeError } from "../api/errors";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useAdoPlugin, useBacklog, useBacklogLiveUpdates } from "../hooks/useBacklog";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { buildBacklogTree, flattenBacklogTree } from "../lib/backlog/tree";
import {
  DEFAULT_BACKLOG_VIEW_STATE,
  readBacklogViewState,
  writeBacklogViewState,
  type BacklogViewState,
} from "../lib/backlog/view-state";
import type { BacklogLastSync } from "../lib/backlog/contract";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { IssueGroupHeader } from "../components/IssueGroupHeader";
import { BacklogTree } from "../components/backlog/BacklogTree";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "../lib/instance-settings";

/** Above this many rows, off-screen rows skip layout and paint (as the Tasks list does). */
const DEFERRED_ROW_THRESHOLD = 150;

function PluginUnavailable({ onOpenPlugins }: { onOpenPlugins: () => void }) {
  return (
    <EmptyState
      icon={ListTree}
      title="Azure DevOps is not available"
      message="The Backlog needs the Azure DevOps plugin installed and running."
      action="Open plugins"
      hideActionIcon
      onAction={onOpenPlugins}
    />
  );
}

export function adoPluginSettingsPath(pluginId: string): string {
  return `${INSTANCE_SETTINGS_PATH_PREFIX}/plugins/${pluginId}`;
}

function useBacklogViewState(companyId: string | null) {
  const [state, setState] = useState<BacklogViewState>(() =>
    companyId ? readBacklogViewState(companyId) : DEFAULT_BACKLOG_VIEW_STATE,
  );
  useEffect(() => {
    setState(companyId ? readBacklogViewState(companyId) : DEFAULT_BACKLOG_VIEW_STATE);
  }, [companyId]);
  const update = useCallback(
    (patch: (previous: BacklogViewState) => BacklogViewState) => {
      setState((previous) => {
        const next = patch(previous);
        if (companyId) writeBacklogViewState(companyId, next);
        return next;
      });
    },
    [companyId],
  );
  return [state, update] as const;
}

function SyncStatus({ lastSync, syncing }: { lastSync: BacklogLastSync | null; syncing: boolean }) {
  if (syncing) return <span className="text-xs text-muted-foreground">Syncing with Azure DevOps…</span>;
  // lastSync reports the last full sync; until the first one the cache only
  // holds what live events and catch-ups brought in.
  if (!lastSync) {
    return <span className="text-xs text-muted-foreground">Not synced yet. Press Sync to pull every work item.</span>;
  }
  return (
    <span className="flex min-w-0 flex-col items-end text-right text-xs text-muted-foreground">
      <span title={formatDateTime(lastSync.finishedAt)}>
        Last sync {timeAgo(lastSync.finishedAt)}
        {lastSync.error ? null : ` · ${lastSync.changed} changed`}
      </span>
      {lastSync.error ? (
        <span role="alert" className="text-destructive">Sync failed: {lastSync.error}</span>
      ) : null}
    </span>
  );
}

export function Backlog() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const { plugin, pluginId, isLoading: pluginLoading } = useAdoPlugin();
  const { query, sync, retry, syncInProgress } = useBacklog(pluginId, selectedCompanyId);
  // Re-reads the tree whenever the plugin records a change (live ADO events, syncs, assignments).
  const live = useBacklogLiveUpdates(pluginId, selectedCompanyId);
  const backlogView = useQueryView(query);
  const [view, updateView] = useBacklogViewState(selectedCompanyId);

  useEffect(() => {
    setBreadcrumbs([{ label: "Backlog" }]);
  }, [setBreadcrumbs]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const agentById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);

  const items = query.data?.items;
  const tree = useMemo(
    () => buildBacklogTree(items ?? [], { showClosed: view.showClosed }),
    [items, view.showClosed],
  );
  const collapsed = useMemo(() => new Set(view.collapsed), [view.collapsed]);
  const epicRows = useMemo(() => flattenBacklogTree(tree.epics, collapsed), [tree.epics, collapsed]);
  const noEpicRows = useMemo(() => flattenBacklogTree(tree.noEpic, collapsed), [tree.noEpic, collapsed]);
  const deferRows = epicRows.length + noEpicRows.length > DEFERRED_ROW_THRESHOLD;

  const toggleRow = useCallback(
    (workItemId: number) =>
      updateView((previous) => ({
        ...previous,
        collapsed: previous.collapsed.includes(workItemId)
          ? previous.collapsed.filter((id) => id !== workItemId)
          : [...previous.collapsed, workItemId],
      })),
    [updateView],
  );

  // Forget collapsed rows whose work items left the backlog, so the stored
  // view does not grow without bound.
  useEffect(() => {
    if (!items) return;
    const present = new Set(items.map((entry) => entry.id));
    updateView((previous) => {
      const kept = previous.collapsed.filter((id) => present.has(id));
      return kept.length === previous.collapsed.length ? previous : { ...previous, collapsed: kept };
    });
  }, [items, updateView]);

  const openPlugins = () => navigate(`${INSTANCE_SETTINGS_PATH_PREFIX}/plugins`);

  if (!selectedCompanyId) {
    return <EmptyState icon={ListTree} message="Select a company to view the backlog." />;
  }
  if (pluginLoading) return <PageSkeleton variant="list" />;
  if (!plugin || !pluginId) return <PluginUnavailable onOpenPlugins={openPlugins} />;
  if (!query.data && isPluginUnavailableError(query.error)) return <PluginUnavailable onOpenPlugins={openPlugins} />;
  if (!query.data && (backlogView.kind === "loading" || backlogView.kind === "reconnecting")) {
    return <PageSkeleton variant="list" />;
  }
  if (!query.data) {
    return (
      <QueryErrorState
        size="page"
        error={backlogView.error}
        action="load the backlog"
        onRetry={retry}
        retrying={backlogView.isFetching}
      />
    );
  }
  // Loaded data stays on screen; a real refresh failure shows inline above it
  // (an outage is explained by the app's connection banner, as elsewhere).
  const refreshError = backlogView.kind === "error" ? backlogView.error : null;

  const data = query.data;
  if (!data.configured) {
    return (
      <EmptyState
        icon={ListTree}
        title="Azure DevOps is not set up"
        message="Add the organization, project and access token in the Azure DevOps plugin settings, then sync the backlog."
        action="Open plugin settings"
        hideActionIcon
        onAction={() => navigate(adoPluginSettingsPath(pluginId))}
      />
    );
  }

  const syncError = sync.error ? describeError(sync.error, { action: "start the sync" }).body : null;
  const syncRefused = sync.data && !sync.data.started ? sync.data.reason : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <ToggleSwitch
            checked={view.showClosed}
            onCheckedChange={(showClosed) => updateView((previous) => ({ ...previous, showClosed }))}
            aria-label="Show closed"
          />
          Show closed
          {!view.showClosed && tree.hiddenClosedCount > 0 ? (
            <span className="text-xs">({tree.hiddenClosedCount} hidden)</span>
          ) : null}
        </label>
        <div className="ml-auto flex items-start gap-3">
          <div className="flex flex-col items-end gap-0.5">
            <SyncStatus lastSync={data.lastSync} syncing={data.syncing} />
            {syncError ? <span role="alert" className="text-xs text-destructive">{syncError}</span> : null}
            {syncRefused ? <span role="status" className="text-xs text-muted-foreground">{syncRefused}</span> : null}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            title={live.connected ? "Updates arrive automatically; refresh to re-read now" : "Live updates are reconnecting; refresh to re-read now"}
          >
            <RotateCw className={`h-3.5 w-3.5${query.isFetching && !syncInProgress ? " animate-spin" : ""}`} aria-hidden />
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => sync.mutate()}
            disabled={syncInProgress}
          >
            {syncInProgress ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
            {syncInProgress ? "Syncing…" : "Sync"}
          </Button>
        </div>
      </div>

      {refreshError ? (
        <QueryErrorState
          size="inline"
          error={refreshError}
          action="refresh the backlog"
          onRetry={retry}
          retrying={query.isFetching}
        />
      ) : null}

      {data.items.length === 0 ? (
        <EmptyState
          icon={ListTree}
          message={syncInProgress ? "Syncing work items from Azure DevOps…" : "No work items yet. Sync to pull the backlog from Azure DevOps."}
          action={syncInProgress ? undefined : "Sync now"}
          hideActionIcon
          onAction={() => sync.mutate()}
        />
      ) : tree.visibleCount === 0 ? (
        <EmptyState icon={ListTree} message="Every work item is closed. Turn on Show closed to see them." />
      ) : (
        <div className="flex flex-col gap-4">
          {epicRows.length > 0 ? (
            <BacklogTree
              label="Epics"
              rows={epicRows}
              collapsed={collapsed}
              onToggle={toggleRow}
              agentById={agentById}
              deferRows={deferRows}
            />
          ) : null}
          {tree.noEpic.length > 0 ? (
            <section aria-label="Not under an Epic" className="flex flex-col">
              <div className="rounded-lg hover:bg-accent/50">
                <IssueGroupHeader
                  label="Not under an Epic"
                  collapsible
                  collapsed={view.noEpicCollapsed}
                  onToggle={() =>
                    updateView((previous) => ({ ...previous, noEpicCollapsed: !previous.noEpicCollapsed }))
                  }
                />
              </div>
              {view.noEpicCollapsed ? null : (
                <BacklogTree
                  label="Not under an Epic"
                  rows={noEpicRows}
                  collapsed={collapsed}
                  onToggle={toggleRow}
                  agentById={agentById}
                  deferRows={deferRows}
                />
              )}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
