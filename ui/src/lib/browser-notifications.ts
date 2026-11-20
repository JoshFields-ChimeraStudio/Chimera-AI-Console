/**
 * Chimera fork (BACKLOG D4): browser notifications for Paperclip's own events while the tab is
 * open but not in view. Built on the sidebar badge counts every page already polls: a new
 * approval, a new failed run, or a task newly waiting for you (an unread Mine task) shows one
 * notification. Web push (with the tab closed) is not built yet.
 */
import type { SidebarBadges } from "@paperclipai/shared";

/** Per browser: Josh turns them on in Profile settings, which also asks the browser's permission. */
export const BROWSER_NOTIFICATIONS_KEY = "paperclip:browser-notifications:enabled";

export interface BrowserNotificationMessage {
  title: string;
  body: string;
  /** Same tag replaces an earlier notification of the same kind instead of stacking. */
  tag: string;
  /** Where clicking it goes (company-relative). */
  path: string;
}

export function browserNotificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function browserNotificationsEnabled(): boolean {
  if (!browserNotificationsSupported() || Notification.permission !== "granted") return false;
  try {
    return window.localStorage.getItem(BROWSER_NOTIFICATIONS_KEY) === "true";
  } catch {
    return false;
  }
}

export function setBrowserNotificationsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(BROWSER_NOTIFICATIONS_KEY, enabled ? "true" : "false");
  } catch {
    // Storage can be unavailable (private mode); notifications then stay off.
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What changed between two badge readings that deserves a notification. */
export function notificationMessages(before: SidebarBadges, after: SidebarBadges, companyName: string): BrowserNotificationMessage[] {
  const out: BrowserNotificationMessage[] = [];
  if (after.approvals > before.approvals) {
    out.push({
      title: `${companyName}: approval needed`,
      body: `${plural(after.approvals, "approval is", "approvals are")} waiting for you.`,
      tag: "approvals",
      path: "/approvals/pending",
    });
  }
  if (after.failedRuns > before.failedRuns) {
    const added = after.failedRuns - before.failedRuns;
    out.push({
      title: `${companyName}: ${added === 1 ? "a run failed" : `${added} runs failed`}`,
      body: "Open the inbox to see what failed.",
      tag: "failed-runs",
      path: "/inbox",
    });
  }
  const seen = new Set(before.unreadIssueIds ?? []);
  const fresh = (after.unreadIssueIds ?? []).filter((id) => !seen.has(id));
  if (fresh.length > 0) {
    out.push({
      title: `${companyName}: ${fresh.length === 1 ? "a task is" : `${fresh.length} tasks are`} waiting for you`,
      body: "Open the inbox to read the update.",
      tag: "mine",
      path: "/inbox",
    });
  }
  return out;
}
