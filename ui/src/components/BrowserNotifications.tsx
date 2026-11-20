/**
 * Chimera fork (BACKLOG D4): browser notifications for approvals, failed runs and tasks waiting
 * for you, while the tab is open in the background. The rules live in lib/browser-notifications.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SidebarBadges } from "@paperclipai/shared";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { useCompany } from "../context/CompanyContext";
import { useSharedPollingQuery } from "../hooks/useSharedPolling";
import { queryKeys } from "../lib/queryKeys";
import { useNavigate } from "@/lib/router";
import {
  browserNotificationsEnabled,
  browserNotificationsSupported,
  notificationMessages,
  setBrowserNotificationsEnabled,
} from "../lib/browser-notifications";
import { Button } from "@/components/ui/button";

/** Rendered once by the layout: watches the badge counts and notifies when the tab is not in view. */
export function BrowserNotifications() {
  const { selectedCompanyId: companyId, selectedCompany } = useCompany();
  const navigate = useNavigate();
  const queryKey = queryKeys.sidebarBadges(companyId ?? "__disabled__");
  // The same shared query the sidebar badge uses: no extra polling, and only the leader tab notifies.
  // leaderOnly makes isLeader report the real cross-tab leader (it is always true otherwise).
  const shared = useSharedPollingQuery({ companyId, resourceKey: "inbox-badge", queryKey, enabled: !!companyId, leaderOnly: true });
  const { data } = useQuery({
    queryKey,
    queryFn: () => sidebarBadgesApi.get(companyId!),
    enabled: !!companyId,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const last = useRef<{ companyId: string; badges: SidebarBadges } | null>(null);

  useEffect(() => {
    if (!companyId || !data) return;
    const before = last.current?.companyId === companyId ? last.current.badges : null;
    last.current = { companyId, badges: data };
    // The first reading is the baseline; nothing is new yet.
    if (!before || !shared.isLeader || document.visibilityState === "visible" || !browserNotificationsEnabled()) return;
    for (const message of notificationMessages(before, data, selectedCompany?.name ?? "Paperclip")) {
      try {
        const notification = new Notification(message.title, { body: message.body, tag: message.tag });
        notification.onclick = () => {
          window.focus();
          navigate(message.path);
          notification.close();
        };
      } catch {
        // Some browsers allow notifications only from a service worker; the badge still shows.
      }
    }
  }, [companyId, data, shared.isLeader, selectedCompany?.name, navigate]);

  return null;
}

/** Profile settings: turn browser notifications on or off for this browser. */
export function BrowserNotificationsControl() {
  const [enabled, setEnabled] = useState(browserNotificationsEnabled);
  const [denied, setDenied] = useState(() => browserNotificationsSupported() && Notification.permission === "denied");
  if (!browserNotificationsSupported()) return null;

  async function turnOn() {
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    setDenied(permission === "denied");
    if (permission !== "granted") return;
    setBrowserNotificationsEnabled(true);
    setEnabled(true);
  }

  function turnOff() {
    setBrowserNotificationsEnabled(false);
    setEnabled(false);
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Browser notifications</h3>
          <p className="text-xs text-muted-foreground">
            While Paperclip is open in a background tab: new approvals, failed runs, and tasks waiting for you. This browser only.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => (enabled ? turnOff() : void turnOn())}>
          {enabled ? "Turn off" : "Turn on"}
        </Button>
      </div>
      {denied ? (
        <p role="status" className="text-xs text-muted-foreground">
          The browser is blocking notifications for this site. Allow them in the browser's site settings, then turn them on here.
        </p>
      ) : null}
    </div>
  );
}
