import { useEffect, useRef, useState } from "react";
import { usePluginAction, usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { AdoStatus } from "../worker.js";
import type { IssueLinkData } from "../links/index.js";
import type { NeedsJoshData, NeedsJoshItem } from "../backlog/index.js";
import type { CleanUpResult, SmokeData, StartResult } from "../smoke/index.js";
import type { PullRequestView, TaskPullRequestsData } from "../pullrequests/view.js";
import type { BuilderQueuesData } from "../routing/index.js";

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

// Keys match SMOKE_DATA_KEY / SMOKE_ACTION_KEYS in ../smoke/index.ts (not imported, to keep worker code out of the UI bundle).
const SMOKE_DATA_KEY = "smoke-test";
const SMOKE_START = "smoke-test-start";
const SMOKE_CLEAN_UP = "smoke-test-clean-up";

function cleanUpText(r: CleanUpResult | null): string {
  if (!r) return "";
  const parts = [`${r.removed.length} closed`];
  if (r.alreadyFinal.length) parts.push(`${r.alreadyFinal.length} already closed`);
  if (r.failed.length) parts.push(`${r.failed.length} failed: ${r.failed.map((f) => `#${f.id} ${f.error}`).join("; ")}`);
  if (r.truncated) parts.push("stopped at the item limit");
  return parts.join(", ");
}

/**
 * Dashboard widget (A10): start a smoke-test Epic (cleaning up the previous one first),
 * or clean up the current one, and Josh's own steps for the run.
 */
export function AdoSmokeTest({ context }: PluginWidgetProps) {
  const companyId = context.companyId;
  const { data, loading, error, refresh } = usePluginData<SmokeData>(SMOKE_DATA_KEY, { companyId });
  const start = usePluginAction(SMOKE_START);
  const cleanUp = usePluginAction(SMOKE_CLEAN_UP);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(kind: "start" | "clean-up") {
    if (kind === "start" && data?.epic && !window.confirm(`Close every open item under smoke-test Epic #${data.epic.id} and start a new one?`)) return;
    if (kind === "clean-up" && !window.confirm(`Close every open item under smoke-test Epic #${data?.epic?.id}?`)) return;
    setBusy(true);
    setMessage(null);
    try {
      if (kind === "start") {
        const res = (await start({ companyId })) as StartResult;
        const cleaned = res.cleanedUp ? ` Previous smoke test: ${cleanUpText(res.cleanedUp)}.` : "";
        setMessage(`Created Epic #${res.epicId} and assigned it to ${res.assignedTo}.${cleaned}`);
      } else {
        const res = (await cleanUp({ companyId })) as CleanUpResult | null;
        setMessage(res ? `Cleaned up: ${cleanUpText(res)}.` : "There was no smoke test to clean up.");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  if (!companyId) return <div>Select a company to run the smoke test.</div>;
  if (loading && !data) return <div>Loading the smoke test…</div>;
  if (error) return <div>Smoke test unavailable: {error.message}</div>;
  if (!data?.configured) return <div>The Azure DevOps plugin is not configured for this company.</div>;
  if (!data.agentName) return <div>Set the smoke-test agent in the Azure DevOps settings to use the smoke test.</div>;

  const epic = data.epic;
  return (
    <div style={{ display: "grid", gap: "0.4rem" }}>
      <div>
        {epic ? (
          <>
            Current:{" "}
            {epic.url ? (
              <a href={epic.url} target="_blank" rel="noreferrer">
                #{epic.id}
              </a>
            ) : (
              `#${epic.id}`
            )}{" "}
            {epic.title} · <strong>{epic.state}</strong>
          </>
        ) : (
          "No smoke test running."
        )}
      </div>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button type="button" onClick={() => void run("start")} disabled={busy}>
          {busy ? "Working…" : epic ? "Reset and start a new smoke test" : `Start a smoke test (assigned to ${data.agentName})`}
        </button>
        {epic ? (
          <button type="button" onClick={() => void run("clean-up")} disabled={busy}>
            Clean up
          </button>
        ) : null}
      </div>
      {message ? <div>{message}</div> : null}
      <details>
        <summary>Your part</summary>
        <ol style={{ margin: "0.25rem 0 0", paddingLeft: "1.2rem" }}>
          {data.joshSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </details>
    </div>
  );
}

// Key matches PR_VIEW_DATA_KEY in ../pullrequests/view.ts (not imported, to keep worker code out of the UI bundle).
const PR_VIEW_DATA_KEY = "task-pull-requests";

const CHECK_LABELS: Record<string, string> = {
  approved: "passed",
  rejected: "failed",
  running: "running",
  queued: "queued",
  notApplicable: "not applicable",
  broken: "broken",
};

function prStatusLabel(pr: PullRequestView): string {
  if (pr.status === "completed") return "Merged";
  if (pr.status === "abandoned") return "Abandoned";
  if (pr.isDraft) return "Draft";
  if (pr.mergeStatus === "conflicts") return "Open · merge conflicts";
  return "Open";
}

/**
 * A5: the task's "Pull request" tab. The pull requests of its work item (a Review's or QA Test's
 * are its Story's), read live: status, reviewers' votes, branch policy checks and open threads.
 */
export function AdoPullRequestTab({ context }: PluginWidgetProps) {
  const companyId = context.companyId;
  const issueId = context.entityId;
  const { data, loading, error, refresh } = usePluginData<TaskPullRequestsData>(PR_VIEW_DATA_KEY, { companyId, issueId });
  const box = { display: "grid", gap: "0.75rem", padding: "0.5rem 0" } as const;
  const muted = { opacity: 0.7, fontSize: "0.85rem" } as const;

  if (loading && !data) return <div style={box}>Loading pull requests from ADO…</div>;
  if (error) return <div style={box} role="alert">Could not load pull requests: {error.message}</div>;
  if (!data?.configured) return <div style={box}>The Azure DevOps plugin is not set up for this company.</div>;
  if (!data.workItemId) return <div style={box}>This task is not linked to an ADO work item.</div>;

  return (
    <div style={box}>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <span style={muted}>
          {data.parentWorkItemId ? `Pull requests of the parent work item #${data.parentWorkItemId}` : `Pull requests of work item #${data.workItemId}`}
        </span>
        <button type="button" onClick={() => refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {data.error ? <div role="alert">ADO: {data.error}</div> : null}
      {!data.error && !data.pullRequests.length ? <div>No pull request is linked yet.</div> : null}
      {data.pullRequests.map((pr) => (
        <section key={pr.pullRequestId} style={{ border: "1px solid rgba(127,127,127,0.3)", borderRadius: 6, padding: "0.75rem", display: "grid", gap: "0.5rem" }}>
          <div>
            <a href={pr.url} target="_blank" rel="noreferrer">
              <strong>
                #{pr.pullRequestId} {pr.title}
              </strong>
            </a>
            <div style={muted}>
              {prStatusLabel(pr)}
              {pr.repositoryName ? ` · ${pr.repositoryName}` : ""}
              {pr.sourceBranch && pr.targetBranch ? ` · ${pr.sourceBranch} → ${pr.targetBranch}` : ""}
              {pr.createdBy ? ` · by ${pr.createdBy}` : ""}
            </div>
          </div>
          <div>
            <strong>Reviewers</strong>
            {pr.reviewers.length ? (
              <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.25rem" }}>
                {pr.reviewers.map((r) => (
                  <li key={r.name}>
                    {r.name}: {r.voteLabel}
                    {r.isRequired ? " (required)" : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <div style={muted}>None</div>
            )}
          </div>
          <div>
            <strong>Checks</strong>
            {pr.checks === null ? (
              <div style={muted}>Not available{pr.checksError ? `: ${pr.checksError}` : ""}</div>
            ) : pr.checks.length ? (
              <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.25rem" }}>
                {pr.checks.map((c, i) => (
                  <li key={`${c.name}-${i}`}>
                    {c.name}: {CHECK_LABELS[c.status] ?? c.status}
                    {c.isBlocking ? "" : " (optional)"}
                  </li>
                ))}
              </ul>
            ) : (
              <div style={muted}>No branch policies</div>
            )}
          </div>
          <div>
            <strong>Open threads ({pr.openThreads.length})</strong>
            {pr.resolvedThreads ? <span style={muted}> · {pr.resolvedThreads} resolved</span> : null}
            {pr.openThreads.length ? (
              <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.25rem", display: "grid", gap: "0.4rem" }}>
                {pr.openThreads.map((t) => (
                  <li key={t.id}>
                    <div style={muted}>
                      {t.author || "Someone"}
                      {t.filePath ? ` on ${t.filePath}${t.line ? ` line ${t.line}` : ""}` : ""}
                      {t.replies ? ` · ${t.replies} repl${t.replies === 1 ? "y" : "ies"}` : ""}
                    </div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{t.excerpt}</div>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}

// Keys match QUEUE_DATA_KEY / QUEUE_ACTION_KEYS in ../routing/index.ts (not imported, to keep worker code out of the UI bundle).
const QUEUE_DATA_KEY = "builder-queues";
const QUEUE_ROUTE_NOW = "builder-queues-route-now";

/**
 * A6: per builder role, what each builder holds against its limit, and the tagged Stories that
 * wait, with why. Read when the dashboard opens or on Refresh; assigns nothing unless you press
 * Route now (which runs the same routing a finished Story or a merge runs).
 */
export function AdoBuilderQueues({ context }: PluginWidgetProps) {
  const companyId = context.companyId;
  const { data, loading, error, refresh } = usePluginData<BuilderQueuesData>(QUEUE_DATA_KEY, { companyId });
  const routeNow = usePluginAction(QUEUE_ROUTE_NOW);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const muted = { opacity: 0.7, fontSize: "0.85rem" } as const;
  const list = { margin: "0.25rem 0 0", paddingLeft: "1.25rem" } as const;

  if (loading && !data) return <div>Loading builder queues…</div>;
  if (error) return <div role="alert">Builder queues unavailable: {error.message}</div>;
  if (!data?.configured) return <div style={muted}>The Azure DevOps plugin is not set up.</div>;
  if (data.error) return <div role="alert">ADO: {data.error}</div>;
  if (!data.routes.length) return <div style={muted}>No builder routes are set (Azure DevOps settings, Builder routes).</div>;

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const res = (await routeNow({ companyId })) as { assigned?: Array<{ workItemId: number; agent: string }> };
      const n = res.assigned?.length ?? 0;
      setMessage(n ? `Started ${res.assigned!.map((a) => `#${a.workItemId} (${a.agent})`).join(", ")}.` : "Nothing could start.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      {data.routes.map((route) => (
        <div key={route.role}>
          <strong>{route.role}</strong>
          <ul style={list}>
            {route.builders.map((b) => (
              <li key={b.name}>
                {b.name}: {b.held.length} of {b.limit}
                {b.status === "missing" ? " (no such agent)" : b.status === "paused" ? " (paused)" : ""}
                {b.held.length ? (
                  <ul style={list}>
                    {b.held.map((h) => (
                      <li key={h.workItemId} style={muted}>
                        #{h.workItemId} {h.title} · {h.state}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div>
        <strong>Waiting ({data.waiting.length})</strong>
        {data.waiting.length ? (
          <ul style={list}>
            {data.waiting.map((w) => (
              <li key={w.workItemId}>
                <a href={w.url} target="_blank" rel="noreferrer">
                  #{w.workItemId} {w.title}
                </a>{" "}
                <span style={muted}>
                  ({w.role}): {w.why}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div style={muted}>Nothing is waiting.</div>
        )}
      </div>
      {data.ready.length ? (
        <div>
          <strong>Ready to start ({data.ready.length})</strong>
          <ul style={list}>
            {data.ready.map((r) => (
              <li key={r.workItemId}>
                #{r.workItemId} {r.title} <span style={muted}>→ {r.agent}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <button type="button" onClick={() => refresh()} disabled={loading || busy}>
          Refresh
        </button>
        <button type="button" onClick={() => void run()} disabled={busy || !data.ready.length} title="Start what is ready now">
          {busy ? "Routing…" : "Route now"}
        </button>
        {message ? <span role="status" style={muted}>{message}</span> : null}
      </div>
    </div>
  );
}
