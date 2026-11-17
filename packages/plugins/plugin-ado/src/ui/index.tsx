import { useEffect, useState } from "react";
import { usePluginAction, usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { AdoStatus } from "../worker.js";
import type { IssueLinkData } from "../links/index.js";

// Keys match LINK_DATA_KEYS / LINK_ACTION_KEYS in ../links/index.ts (not imported, to keep worker code out of the UI bundle).
const LINK_DATA_KEY = "issue-link";
const LINK_ACTION = "link-work-item";
const UNLINK_ACTION = "unlink-work-item";

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

/**
 * Task toolbar: "ADO #123 · Active" linking to the work item, with link and unlink controls.
 * The link itself lives on the task (origin fields) and in the plugin's ado_links table.
 */
export function AdoTaskLink({ context }: PluginWidgetProps) {
  const companyId = context.companyId;
  const issueId = context.entityId;
  const { data, loading, error, refresh } = usePluginData<IssueLinkData>(LINK_DATA_KEY, { companyId, issueId });
  const linkAction = usePluginAction(LINK_ACTION);
  const unlinkAction = usePluginAction(UNLINK_ACTION);
  const [editing, setEditing] = useState(false);
  const [workItemId, setWorkItemId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!companyId || !issueId || (loading && !data)) return null;
  if (error) return <span title={error.message}>ADO link unavailable</span>;
  if (!data?.configured && !data?.link) return null;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = (await action()) as { ok: boolean; error?: string };
      if (!res.ok) setMessage(res.error ?? "Failed");
      else {
        setEditing(false);
        setWorkItemId("");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  const link = data?.link;
  const chipStyle = { display: "inline-flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem" } as const;
  return (
    <span style={chipStyle}>
      {link ? (
        <>
          <a href={link.url} target="_blank" rel="noreferrer" title={link.title ? `${link.type}: ${link.title}` : link.type}>
            ADO #{link.workItemId} · {link.state || "unknown"}
          </a>
          {link.missingAt ? <span title={`Not found in ADO since ${new Date(link.missingAt).toLocaleString()}`}>(not found in ADO)</span> : null}
          <button type="button" disabled={busy} onClick={() => void run(() => unlinkAction({ companyId, issueId }))}>
            Unlink
          </button>
        </>
      ) : editing ? (
        <form
          style={chipStyle}
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => linkAction({ companyId, issueId, workItemId }));
          }}
        >
          <input
            aria-label="ADO work item ID"
            placeholder="Work item ID"
            value={workItemId}
            onChange={(e) => setWorkItemId(e.target.value)}
            size={10}
            autoFocus
          />
          <button type="submit" disabled={busy || !workItemId.trim()}>
            {busy ? "Linking…" : "Link"}
          </button>
          <button type="button" disabled={busy} onClick={() => { setEditing(false); setMessage(null); }}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setEditing(true)}>
          Link ADO item
        </button>
      )}
      {message ? <span role="alert">{message}</span> : null}
    </span>
  );
}
