// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import type { BacklogData, BacklogItem } from "../lib/backlog/contract";
import { backlogViewStorageKey } from "../lib/backlog/view-state";
import { Backlog } from "./Backlog";

const mockPluginsApi = vi.hoisted(() => ({
  list: vi.fn(),
  bridgeGetData: vi.fn(),
  bridgePerformAction: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("../api/plugins", () => ({ pluginsApi: mockPluginsApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => mockNavigate,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  const maybePromise = result as Promise<void> | undefined;
  if (maybePromise !== undefined && typeof maybePromise.then === "function") {
    return maybePromise.then(() => {
      flushSync(() => {});
    });
  }
  return result;
}

async function flushQueries() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const ADO_PLUGIN = { id: "plugin-ado-1", pluginKey: "chimera.plugin-ado", status: "ready" };

function item(id: number, type: string, parentId: number | null, extra: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id,
    parentId,
    type,
    typeColor: null,
    title: `${type} ${id}`,
    state: "New",
    stateCategory: "Proposed",
    stackRank: null,
    url: `https://dev.azure.com/x/${id}`,
    linkedTask: null,
    ...extra,
  };
}

function backlog(overrides: Partial<BacklogData> = {}): BacklogData {
  return {
    configured: true,
    syncing: false,
    lastSync: { finishedAt: new Date().toISOString(), trigger: "manual", changed: 3 },
    items: [
      item(1, "Epic", null),
      item(2, "Feature", 1, {
        linkedTask: { issueId: "issue-2", identifier: "CHI-2", status: "in_progress", assigneeAgentId: "agent-1" },
      }),
      item(3, "User Story", 2, { state: "Closed", stateCategory: "Completed" }),
      item(9, "Bug", null),
    ],
    ...overrides,
  };
}

describe("Backlog", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    mockPluginsApi.list.mockResolvedValue([ADO_PLUGIN]);
    mockPluginsApi.bridgeGetData.mockResolvedValue({ data: backlog() });
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "Ember", status: "idle" }]);
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  let queryClient: QueryClient;
  async function render() {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <Backlog />
        </QueryClientProvider>,
      );
    });
    await flushQueries();
  }

  const rowIds = () => [...container.querySelectorAll("[data-backlog-row-id]")].map((row) => row.getAttribute("data-backlog-row-id"));

  it("renders the tree with the no-Epic group last and the linked task's agent", async () => {
    await render();
    expect(mockPluginsApi.bridgeGetData).toHaveBeenCalledWith("plugin-ado-1", "backlog", {}, "company-1");
    expect(rowIds()).toEqual(["1", "2", "9"]);
    const noEpic = container.querySelector('section[aria-label="Not under an Epic"]');
    expect(noEpic?.textContent).toContain("Bug 9");
    const featureRow = container.querySelector('[data-backlog-row-id="2"]');
    expect(featureRow?.querySelector('[data-slot="backlog-row-agent"]')?.textContent).toContain("Ember");
    expect(featureRow?.querySelector("a")?.getAttribute("href")).toBe("/backlog/2");
    expect(container.textContent).toContain("1 hidden");
  });

  it("shows closed items with Show closed and remembers the choice", async () => {
    await render();
    const toggle = container.querySelector('button[role="switch"][aria-label="Show closed"]') as HTMLButtonElement;
    await act(() => toggle.click());
    expect(rowIds()).toEqual(["1", "2", "3", "9"]);
    expect(JSON.parse(window.localStorage.getItem(backlogViewStorageKey("company-1"))!).showClosed).toBe(true);
  });

  it("collapses and expands a row and remembers it", async () => {
    await render();
    const collapse = container.querySelector('button[aria-label="Collapse 1"]') as HTMLButtonElement;
    await act(() => collapse.click());
    expect(rowIds()).toEqual(["1", "9"]);
    expect(container.querySelector('[data-backlog-row-id="1"]')?.textContent).toContain("(1 item)");
    expect(JSON.parse(window.localStorage.getItem(backlogViewStorageKey("company-1"))!).collapsed).toEqual([1]);

    await act(() => root?.unmount());
    root = null;
    await render();
    expect(rowIds()).toEqual(["1", "9"]);
  });

  it("starts a sync, shows progress while syncing and refreshes when it ends", async () => {
    mockPluginsApi.bridgePerformAction.mockResolvedValue({ data: { started: true } });
    mockPluginsApi.bridgeGetData.mockResolvedValue({ data: backlog({ syncing: true }) });
    await render();
    const syncButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Sync"))!;
    expect(syncButton.disabled).toBe(true);
    expect(syncButton.textContent).toContain("Syncing");
    expect(container.textContent).toContain("Syncing with Azure DevOps");

    mockPluginsApi.bridgeGetData.mockResolvedValue({
      data: backlog({ lastSync: { finishedAt: new Date().toISOString(), trigger: "manual", changed: 0, error: "ADO returned 401" } }),
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2100));
    });
    await flushQueries();
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Sync"))!;
    expect(button.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Sync failed: ADO returned 401");

    await act(() => button.click());
    await flushQueries();
    expect(mockPluginsApi.bridgePerformAction).toHaveBeenCalledWith("plugin-ado-1", "sync-backlog", {}, "company-1");
  });

  it("links to the plugin settings when ADO is not configured", async () => {
    mockPluginsApi.bridgeGetData.mockResolvedValue({ data: backlog({ configured: false, items: [] }) });
    await render();
    expect(container.textContent).toContain("Azure DevOps is not set up");
    const action = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Open plugin settings"))!;
    await act(() => action.click());
    expect(mockNavigate).toHaveBeenCalledWith("/company/settings/instance/plugins/plugin-ado-1");
  });

  it("explains an empty backlog", async () => {
    mockPluginsApi.bridgeGetData.mockResolvedValue({ data: backlog({ items: [], lastSync: null }) });
    await render();
    expect(container.textContent).toContain("No work items yet");
    expect(container.textContent).toContain("Not synced yet");
    mockPluginsApi.bridgePerformAction.mockResolvedValue({ data: { started: true } });
    const action = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Sync now"))!;
    await act(() => action.click());
    await flushQueries();
    expect(mockPluginsApi.bridgePerformAction).toHaveBeenCalledWith("plugin-ado-1", "sync-backlog", {}, "company-1");
  });

  it("shows why a sync did not start", async () => {
    mockPluginsApi.bridgePerformAction.mockResolvedValue({ data: { started: false, reason: "A catch-up is already running." } });
    await render();
    const syncButton = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Sync")!;
    await act(() => syncButton.click());
    await flushQueries();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("A catch-up is already running.");
  });

  it("does not call the plugin when the ADO plugin is not ready", async () => {
    mockPluginsApi.list.mockResolvedValue([{ ...ADO_PLUGIN, status: "error" }]);
    await render();
    expect(container.textContent).toContain("Azure DevOps is not available");
    expect(mockPluginsApi.bridgeGetData).not.toHaveBeenCalled();
  });
  it("exposes the rows as an ARIA tree", async () => {
    await render();
    const trees = [...container.querySelectorAll('[role="tree"]')].map((tree) => tree.getAttribute("aria-label"));
    expect(trees).toEqual(["Epics", "Not under an Epic"]);
    const epic = container.querySelector('[data-backlog-row-id="1"]')!;
    expect(epic.getAttribute("role")).toBe("treeitem");
    expect(epic.getAttribute("aria-level")).toBe("1");
    expect(epic.getAttribute("aria-expanded")).toBe("true");
    expect(epic.getAttribute("aria-posinset")).toBe("1");
    expect(epic.getAttribute("aria-setsize")).toBe("1");
    expect(epic.getAttribute("tabindex")).toBe("0");
    const feature = container.querySelector('[data-backlog-row-id="2"]')!;
    expect(feature.getAttribute("aria-level")).toBe("2");
    expect(feature.getAttribute("tabindex")).toBe("-1");
    expect(feature.getAttribute("aria-label")).toContain("Feature 2: Feature 2");
    expect(feature.getAttribute("aria-label")).toContain("agent Ember");
    expect(container.querySelector('[data-backlog-row-id="9"]')!.hasAttribute("aria-expanded")).toBe(false);
  });

  it("moves through the tree with the arrow keys", async () => {
    mockPluginsApi.bridgeGetData.mockResolvedValue({ data: backlog({ items: [...backlog().items, item(4, "Feature", 1)] }) });
    await render();
    const row = (id: number) => container.querySelector<HTMLElement>(`[data-backlog-row-id="${id}"]`)!;
    const press = (key: string) =>
      act(() => {
        (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });

    await act(() => row(1).focus());
    await press("ArrowDown");
    expect(document.activeElement).toBe(row(2));
    expect(row(2).getAttribute("tabindex")).toBe("0");
    expect(row(1).getAttribute("tabindex")).toBe("-1");
    await press("ArrowLeft");
    expect(document.activeElement).toBe(row(1));
    await press("ArrowLeft");
    expect(row(1).getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-backlog-row-id="2"]')).toBeNull();
    await press("ArrowRight");
    expect(row(1).getAttribute("aria-expanded")).toBe("true");
    await press("ArrowRight");
    expect(document.activeElement).toBe(row(2));
    await press("End");
    expect(document.activeElement).toBe(row(4));
    await press("Home");
    expect(document.activeElement).toBe(row(1));
    await press("Enter");
    expect(mockNavigate).toHaveBeenCalledWith("/backlog/1");
  });

  it("keeps the loaded tree and shows a refresh failure inline", async () => {
    await render();
    mockPluginsApi.bridgeGetData.mockRejectedValue(
      new ApiError("Request failed: 502", 502, { code: "WORKER_ERROR", message: "ADO returned 401: check the access token." }),
    );
    await act(async () => {
      await queryClient.invalidateQueries({ refetchType: "active" });
    });
    await flushQueries();
    expect(rowIds()).toEqual(["1", "2", "9"]);
    expect(container.querySelector('[data-query-view="error"]')?.textContent).toContain("ADO returned 401");
  });

  it("shows the plugin as unavailable when the bridge has no such plugin", async () => {
    mockPluginsApi.bridgeGetData.mockRejectedValue(new ApiError("Plugin not found", 404, { error: "Plugin not found" }));
    await render();
    expect(container.textContent).toContain("Azure DevOps is not available");
  });

  it("forgets collapsed rows that are no longer in the backlog", async () => {
    window.localStorage.setItem(
      backlogViewStorageKey("company-1"),
      JSON.stringify({ collapsed: [1, 777], noEpicCollapsed: false, showClosed: false }),
    );
    await render();
    expect(rowIds()).toEqual(["1", "9"]);
    expect(JSON.parse(window.localStorage.getItem(backlogViewStorageKey("company-1"))!).collapsed).toEqual([1]);
  });
});
