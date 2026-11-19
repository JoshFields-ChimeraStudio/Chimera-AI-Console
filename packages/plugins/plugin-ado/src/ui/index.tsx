import { useEffect, useRef, useState } from "react";
import { usePluginAction, usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { AdoStatus } from "../worker.js";
import type { IssueLinkData } from "../links/index.js";
import type { NeedsJoshData, NeedsJoshItem } from "../backlog/index.js";

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

// Key matches BACKLOG_DATA_KEYS.needsJosh in ../backlog/index.ts.
const NEEDS_JOSH_DATA_KEY = "needs-josh";
const NEEDS_JOSH_REFRESH_MS = 30_000;

/** An item waits for Josh in a given state; a new state is a new wait. */
const waitKey = (item: Pick<NeedsJoshItem, "id" | "state">) => `${item.id}:${item.state}`;

function readSeen(storageKey: string): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}

function writeSeen(storageKey: string, keys: Iterable<string>) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...keys]));
  } catch {
    // Storage can be unavailable (private mode); notifications then repeat after a reload.
  }
}

function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * Global toolbar: "ADO · N need you", the ADO items waiting for Josh (D4), with
 * a Windows notification (through the browser) when a new one appears while a
 * Paperclip tab is open.
 */
export function AdoNeedsJosh({ context }: PluginWidgetProps) {
  const companyId = context.companyId;
  const { data, error, refresh } = usePluginData<NeedsJoshData>(NEEDS_JOSH_DATA_KEY, { companyId });
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<string>(() => (notificationsSupported() ? Notification.permission : "unsupported"));
  const firstLoad = useRef(true);

  useEffect(() => {
    if (!companyId) return;
    const timer = setInterval(() => refresh(), NEEDS_JOSH_REFRESH_MS);
    return () => clearInterval(timer);
  }, [companyId, refresh]);

  // Notify about waits not seen before. The first load only records what is already waiting.
  useEffect(() => {
    if (!companyId || !data?.items) return;
    const storageKey = `chimera.plugin-ado:needs-josh-seen:${companyId}`;
    const seen = readSeen(storageKey);
    const current = data.items.map(waitKey);
    const fresh = seen ? data.items.filter((i) => !seen.has(waitKey(i))) : [];
    writeSeen(storageKey, current);
    const wasFirst = firstLoad.current;
    firstLoad.current = false;
    if (wasFirst && !seen) return;
    if (!fresh.length || !notificationsSupported() || Notification.permission !== "granted") return;
    for (const item of fresh.slice(0, 3)) {
      const n = new Notification(`ADO: ${item.action}`, { body: `${item.type} #${item.id} ${item.title}`, tag: `ado-${waitKey(item)}` });
      n.onclick = () => {
        window.focus();
        if (context.companyPrefix) window.location.assign(`/${context.companyPrefix}/backlog/${item.id}`);
        n.close();
      };
    }
    if (fresh.length > 3) new Notification("ADO", { body: `${fresh.length - 3} more items need you.`, tag: "ado-more" });
  }, [companyId, data, context.companyPrefix]);

  if (!companyId || error || !data?.configured) return null;
  const items = data.items;

  async function enableNotifications() {
    if (!notificationsSupported()) return;
    setPermission(await Notification.requestPermission());
  }

  const count = items.length;
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={count ? `${count} Azure DevOps item${count === 1 ? "" : "s"} waiting for you` : "Nothing in Azure DevOps is waiting for you"}
        style={{ fontSize: "0.8rem", padding: "0.15rem 0.5rem", fontWeight: count ? 600 : 400 }}
      >
        ADO · {count ? `${count} need${count === 1 ? "s" : ""} you` : "nothing waiting"}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Azure DevOps items waiting for you"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 4px)",
            zIndex: 50,
            width: "24rem",
            maxHeight: "28rem",
            overflowY: "auto",
            padding: "0.5rem",
            borderRadius: "0.5rem",
            border: "1px solid var(--border, #ccc)",
            background: "var(--popover, var(--background, #fff))",
            color: "var(--popover-foreground, inherit)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            fontSize: "0.8rem",
            display: "grid",
            gap: "0.5rem",
          }}
        >
          {count === 0 ? <div>Nothing in Azure DevOps is waiting for you.</div> : null}
          {items.map((item) => (
            <div key={waitKey(item)} style={{ display: "grid", gap: "0.15rem" }}>
              <div style={{ fontWeight: 600 }}>{item.action}</div>
              <div>
                {item.type} #{item.id} {item.title}
              </div>
              <div style={{ display: "flex", gap: "0.75rem", opacity: 0.8 }}>
                <span>{item.since ? `since ${new Date(item.since).toLocaleString()}` : item.state}</span>
                {context.companyPrefix ? <a href={`/${context.companyPrefix}/backlog/${item.id}`}>Backlog</a> : null}
                <a href={item.url} target="_blank" rel="noreferrer">
                  Open in ADO
                </a>
              </div>
            </div>
          ))}
          <div style={{ borderTop: "1px solid var(--border, #ccc)", paddingTop: "0.4rem" }}>
            {permission === "granted" ? (
              <span>Windows notifications are on while a Paperclip tab is open.</span>
            ) : permission === "denied" ? (
              <span>Windows notifications are blocked for this site in the browser's settings.</span>
            ) : permission === "unsupported" ? (
              <span>This browser cannot show notifications.</span>
            ) : (
              <button type="button" onClick={() => void enableNotifications()}>
                Turn on Windows notifications
              </button>
            )}
          </div>
        </div>
      ) : null}
    </span>
  );
}
