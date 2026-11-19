// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ThemeProvider } from "../context/ThemeContext";
import type { WorkItemDetail } from "../lib/backlog/contract";
import { BacklogWorkItem } from "./BacklogWorkItem";

const mockPluginsApi = vi.hoisted(() => ({
  list: vi.fn(),
  bridgeGetData: vi.fn(),
  bridgePerformAction: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockParams = vi.hoisted(() => ({ workItemId: "42" as string | undefined }));

vi.mock("../api/plugins", () => ({ pluginsApi: mockPluginsApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
  useOptionalCompany: () => null,
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
  useParams: () => mockParams,
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: "/PAP/backlog/42", search: "", hash: "", state: null }),
}));
// The agent output reuses the task page's thread and run ledger; those have
// their own tests. Here it only needs to receive the linked task.
vi.mock("../components/backlog/LinkedTaskAgentOutput", () => ({
  LinkedTaskAgentOutput: ({ issueId }: { issueId: string }) => (
    <div data-testid="agent-output" data-issue-id={issueId} />
  ),
}));
// A plain select stands in for the popover picker so the test drives onChange.
vi.mock("../components/InlineEntitySelector", () => ({
  InlineEntitySelector: ({
    value,
    options,
    noneLabel,
    onChange,
    disabled,
  }: {
    value: string;
    options: Array<{ id: string; label: string }>;
    noneLabel: string;
    onChange: (id: string) => void;
    disabled?: boolean;
  }) => (
    <select aria-label="Assign to agent" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">{noneLabel}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>{option.label}</option>
      ))}
    </select>
  ),
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

function workItem(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  return {
    id: 42,
    type: "User Story",
    typeColor: null,
    title: "Let Josh hand work to an agent",
    state: "Active",
    stateCategory: "InProgress",
    url: "https://dev.azure.com/chimera/AI%20Testing/_workitems/edit/42",
    descriptionMarkdown:
      "The **backlog** view.\n\n<img src=x onerror=\"window.__pwned=true\"><script>window.__pwned=true</script><b>raw bold</b>",
    acceptanceCriteriaMarkdown: "- [ ] Sidebar item\n- [ ] Tree view",
    technicalNotesMarkdown: "Use `pluginsApi`.\n\n![diagram](https://dev.azure.com/attachments/1.png)",
    pullRequests: [
      { id: 7, title: "Backlog UI", status: "active", repository: "Chimera-AI-Console", url: "https://dev.azure.com/chimera/_git/repo/pullrequest/7" },
    ],
    related: [
      { id: 40, relation: "Parent", type: "Feature", title: "Backlog view", state: "Active", url: "https://dev.azure.com/x/40" },
      { id: 43, relation: "Child", type: "Task", title: "Build the tree", state: "New", url: "https://dev.azure.com/x/43" },
      { id: 50, relation: "Related", type: "Bug", title: "Old sync bug", state: "Closed", url: "https://dev.azure.com/x/50" },
    ],
    comments: [
      { id: 2, author: "Josh Fields", createdDate: "2026-11-16T10:00:00Z", markdown: "Looks good, <i>ship it</i>." },
      { id: 1, author: "Tiamat", createdDate: "2026-11-15T10:00:00Z", markdown: "First draft." },
    ],
    linkedTask: null,
    ...overrides,
  };
}

describe("BacklogWorkItem", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockParams.workItemId = "42";
    mockPluginsApi.list.mockResolvedValue([ADO_PLUGIN]);
    mockPluginsApi.bridgeGetData.mockResolvedValue({ data: workItem() });
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-1", name: "Tiamat", status: "idle", role: "ceo" },
      { id: "agent-2", name: "Ember", status: "idle", role: "engineer" },
    ]);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    delete (window as { __pwned?: boolean }).__pwned;
    vi.clearAllMocks();
  });

  async function render() {
    const tree: ReactNode = (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BacklogWorkItem />
        </ThemeProvider>
      </QueryClientProvider>
    );
    await act(async () => {
      root = createRoot(container);
      root.render(tree);
    });
    await flushQueries();
  }

  it("asks the plugin for the work item through the bridge, by plugin id", async () => {
    await render();
    expect(mockPluginsApi.bridgeGetData).toHaveBeenCalledWith("plugin-ado-1", "work-item", { workItemId: 42 }, "company-1");
  });

  it("renders every field of the contract response", async () => {
    await render();
    const page = container.querySelector('[data-testid="backlog-work-item"]')!;
    expect(page).not.toBeNull();

    const typeIcon = page.querySelector('[data-work-item-type="User Story"]');
    expect(typeIcon?.getAttribute("aria-label")).toBe("User Story");

    const adoLink = [...page.querySelectorAll("a")].find((a) => a.textContent?.trim() === "42");
    expect(adoLink?.getAttribute("href")).toBe("https://dev.azure.com/chimera/AI%20Testing/_workitems/edit/42");
    expect(adoLink?.getAttribute("target")).toBe("_blank");
    expect(adoLink?.getAttribute("rel")).toBe("noopener noreferrer");

    expect(page.querySelector("h2")?.textContent).toBe("Let Josh hand work to an agent");
    expect(page.textContent).toContain("Active");

    const description = page.querySelector('section[aria-label="Description"]')!;
    expect(description.querySelector("strong")?.textContent).toBe("backlog");
    const acceptance = page.querySelector('section[aria-label="Acceptance criteria"]')!;
    expect(acceptance.textContent).toContain("Sidebar item");
    expect(acceptance.textContent).toContain("Tree view");
    const notes = page.querySelector('section[aria-label="Technical notes"]')!;
    expect(notes.querySelector("code")?.textContent).toBe("pluginsApi");

    const pr = [...page.querySelectorAll('section[aria-label="Pull requests"] a')][0];
    expect(pr?.getAttribute("href")).toBe("https://dev.azure.com/chimera/_git/repo/pullrequest/7");
    expect(pr?.getAttribute("target")).toBe("_blank");
    expect(pr?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(pr?.textContent).toContain("Backlog UI");

    const relatedHrefs = [...page.querySelectorAll('section[aria-label="Related work items"] a')].map((a) => a.getAttribute("href"));
    expect(relatedHrefs).toEqual(["/backlog/40", "/backlog/43", "/backlog/50"]);
    const related = page.querySelector('section[aria-label="Related work items"]')!.textContent;
    expect(related).toContain("Parent");
    expect(related).toContain("Children");
    expect(related).toContain("Related");

    const comments = page.querySelector('section[aria-label="Comments"]')!;
    const commentItems = [...comments.querySelectorAll("li")].map((li) => li.textContent);
    expect(commentItems[0]).toContain("Josh Fields");
    expect(commentItems[1]).toContain("Tiamat");

    expect(page.querySelector('section[aria-label="Agent output"]')?.textContent).toContain("No agent is working on this yet");
    expect(mockSetBreadcrumbs).toHaveBeenLastCalledWith([
      { label: "Backlog", href: "/backlog" },
      { label: "Let Josh hand work to an agent", identifier: "42" },
    ]);
  });

  it("never injects raw HTML from ADO content", async () => {
    await render();
    const page = container.querySelector('[data-testid="backlog-work-item"]')!;
    expect(page.querySelector("script")).toBeNull();
    expect(page.querySelector("[onerror]")).toBeNull();
    expect(page.querySelector("b")).toBeNull();
    expect(page.querySelector("i")).toBeNull();
    // Images stay inert references: ADO attachments are never fetched.
    expect(page.querySelector("img")).toBeNull();
    expect(page.querySelector('section[aria-label="Technical notes"]')?.textContent).toContain("Image: diagram");
    expect((window as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("shows the linked task and its agent output when there is one", async () => {
    mockPluginsApi.bridgeGetData.mockResolvedValue({
      data: workItem({ linkedTask: { issueId: "issue-9", identifier: "CHI-9", status: "in_progress", assigneeAgentId: "agent-2" } }),
    });
    await render();
    const taskLink = [...container.querySelectorAll("a")].find((a) => a.textContent === "CHI-9");
    expect(taskLink?.getAttribute("href")).toBe("/issues/CHI-9");
    expect(container.textContent).toContain("In progress");
    expect((container.querySelector('select[aria-label="Assign to agent"]') as HTMLSelectElement).value).toBe("agent-2");
    expect(container.querySelector('[data-testid="agent-output"]')?.getAttribute("data-issue-id")).toBe("issue-9");
  });

  it("assigns an agent through assign-agent and refreshes the work item", async () => {
    mockPluginsApi.bridgePerformAction.mockResolvedValue({ data: { issueId: "issue-9", identifier: "CHI-9", created: true } });
    await render();
    expect(mockPluginsApi.bridgeGetData).toHaveBeenCalledTimes(1);
    mockPluginsApi.bridgeGetData.mockResolvedValue({
      data: workItem({ linkedTask: { issueId: "issue-9", identifier: "CHI-9", status: "todo", assigneeAgentId: "agent-2" } }),
    });

    const select = container.querySelector('select[aria-label="Assign to agent"]') as HTMLSelectElement;
    await act(() => {
      select.value = "agent-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushQueries();

    expect(mockPluginsApi.bridgePerformAction).toHaveBeenCalledWith(
      "plugin-ado-1",
      "assign-agent",
      { workItemId: 42, agentId: "agent-2" },
      "company-1",
    );
    expect(mockPluginsApi.bridgeGetData).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Created task CHI-9.");
    expect([...container.querySelectorAll("a")].some((a) => a.textContent === "CHI-9")).toBe(true);
  });

  it("unassigns with agentId null when Unassigned is chosen", async () => {
    mockPluginsApi.bridgeGetData.mockResolvedValue({
      data: workItem({ linkedTask: { issueId: "issue-9", identifier: "CHI-9", status: "todo", assigneeAgentId: "agent-2" } }),
    });
    mockPluginsApi.bridgePerformAction.mockResolvedValue({ data: { issueId: "issue-9", identifier: "CHI-9", created: false } });
    await render();

    const select = container.querySelector('select[aria-label="Assign to agent"]') as HTMLSelectElement;
    await act(() => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushQueries();

    expect(mockPluginsApi.bridgePerformAction).toHaveBeenCalledWith(
      "plugin-ado-1",
      "assign-agent",
      { workItemId: 42, agentId: null },
      "company-1",
    );
  });

  it("does nothing when Unassigned is chosen and there is no linked task", async () => {
    await render();
    const select = container.querySelector('select[aria-label="Assign to agent"]') as HTMLSelectElement;
    await act(() => {
      select.value = "agent-1";
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushQueries();
    expect(mockPluginsApi.bridgePerformAction).not.toHaveBeenCalled();
  });

  it("shows the plugin's assign error", async () => {
    mockPluginsApi.bridgePerformAction.mockRejectedValue(
      new ApiError("Request failed: 502", 502, { code: "WORKER_ERROR", message: "Agent Ember is paused." }),
    );
    await render();
    const select = container.querySelector('select[aria-label="Assign to agent"]') as HTMLSelectElement;
    await act(() => {
      select.value = "agent-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushQueries();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Agent Ember is paused.");
  });

  it("shows a clear state when ADO no longer has the work item", async () => {
    mockPluginsApi.bridgeGetData.mockRejectedValue(
      new ApiError("Request failed: 502", 502, { code: "WORKER_ERROR", message: "Work item 42 was not found in Azure DevOps." }),
    );
    await render();
    expect(container.textContent).toContain("Not found in Azure DevOps");
    expect(container.textContent).toContain("Work item 42 was not found in Azure DevOps.");
    expect(mockPluginsApi.bridgeGetData).toHaveBeenCalledTimes(1);
  });

  it("keeps the loaded work item and shows a refresh failure inline", async () => {
    await render();
    mockPluginsApi.bridgeGetData.mockRejectedValue(
      new ApiError("Request failed: 502", 502, { code: "WORKER_ERROR", message: "ADO returned 500." }),
    );
    await act(async () => {
      await queryClient.invalidateQueries({ refetchType: "active" });
    });
    await flushQueries();
    expect(container.querySelector("h2")?.textContent).toBe("Let Josh hand work to an agent");
    expect(container.querySelector('[data-query-view="error"]')?.textContent).toContain("ADO returned 500.");
  });

  it("treats a bridge 404 as the plugin missing, not the work item", async () => {
    mockPluginsApi.bridgeGetData.mockRejectedValue(new ApiError("Plugin not found", 404, { error: "Plugin not found" }));
    await render();
    expect(container.textContent).toContain("Azure DevOps is not available");
    expect(container.textContent).not.toContain("Not found in Azure DevOps");
  });

  it("shows other plugin errors with their message", async () => {
    mockPluginsApi.bridgeGetData.mockRejectedValue(
      new ApiError("Request failed: 502", 502, { code: "WORKER_ERROR", message: "ADO returned 401: check the access token." }),
    );
    await render();
    expect(container.querySelector('[data-query-view="error"]')?.textContent).toContain("ADO returned 401: check the access token.");
  });

  it("rejects an ID that is not a number without calling the plugin", async () => {
    mockParams.workItemId = "abc";
    await render();
    expect(container.textContent).toContain("This is not a work item ID.");
    expect(mockPluginsApi.bridgeGetData).not.toHaveBeenCalled();
  });
});
