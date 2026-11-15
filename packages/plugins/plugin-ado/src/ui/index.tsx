import { useEffect, useState } from "react";
import { usePluginAction, usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { AdoStatus } from "../worker.js";

const LISTENER_LABEL: Record<AdoStatus["listener"], string> = {
  not_configured: "Not configured",
  starting: "Connecting…",
  listening: "Listening",
  error: "Error",
};

function when(iso: string | undefined | null): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

export function AdoStatusWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId;
  const { data, loading, error, refresh } = usePluginData<AdoStatus>("status", { companyId });
  const syncNow = usePluginAction("sync-now");
  /** When Sync now was pressed, until the worker reports that sync as running or finished. */
  const [requested, setRequested] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const syncing = requested !== null || !!data?.syncing;

  // The catch-up runs in the background; refresh the status until it has finished.
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(() => refresh(), 2000);
    return () => clearInterval(timer);
  }, [syncing, refresh]);

  // Clear the local flag once the worker reports the sync as running, or as finished after the press
  // (a fast sync can finish between two refreshes). Give up after a minute so the button cannot stick.
  const lastStarted = data?.lastSync ? Date.parse(data.lastSync.startedAt) : 0;
  useEffect(() => {
    if (requested === null) return;
    if (data?.syncing || lastStarted >= requested - 5000 || Date.now() - requested > 60_000) setRequested(null);
  }, [requested, data?.syncing, lastStarted]);

  async function onSync() {
    setMessage(null);
    try {
      const res = (await syncNow({ companyId })) as { started: true } | { started: false; reason: string };
      if (!res.started) setMessage(res.reason);
      else setRequested(Date.now());
    } catch (err) {
      setMessage(`Sync failed to start: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      refresh();
    }
  }

  if (!companyId) return <div>Select a company to see Azure DevOps status.</div>;
  if (loading && !data) return <div>Loading Azure DevOps status…</div>;
  if (error) return <div>Azure DevOps status unavailable: {error.message}</div>;

  return (
    <div style={{ display: "grid", gap: "0.4rem" }}>
      <div>
        Events: <strong>{data ? LISTENER_LABEL[data.listener] : "unknown"}</strong>
        {data?.listenerError ? <span> ({data.listenerError})</span> : null}
      </div>
      <div>Last event: {data?.lastEvent ? `${data.lastEvent.eventType}, ${when(data.lastEvent.at)}` : "none yet"}</div>
      <div>
        Last sync: {data?.lastSync ? `${when(data.lastSync.finishedAt)} (${data.lastSync.trigger}, ${data.lastSync.changed} changed)` : "never"}
        {data?.lastSync?.error ? <span> failed: {data.lastSync.error}</span> : null}
      </div>
      <div>
        <button onClick={() => void onSync()} disabled={syncing || !data?.configured}>
          {syncing ? "Syncing…" : "Sync now"}
        </button>
        {message ? <span style={{ marginLeft: "0.5rem" }}>{message}</span> : null}
      </div>
    </div>
  );
}
