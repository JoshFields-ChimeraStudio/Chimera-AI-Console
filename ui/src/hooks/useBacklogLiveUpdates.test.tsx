// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BACKLOG_LIVE_DEBOUNCE_MS, useBacklogLiveUpdates } from "./useBacklog";
import { queryKeys } from "../lib/queryKeys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Minimal renderHook: mounts a component that calls the hook. */
function renderHook(hook: () => unknown, { wrapper: Wrapper }: { wrapper: (props: { children: ReactNode }) => ReactNode }) {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  function Probe() {
    hook();
    return null;
  }
  act(() => root.render(<Wrapper><Probe /></Wrapper>));
  return { unmount: () => act(() => root.unmount()) };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  send(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

describe("useBacklogLiveUpdates", () => {
  let client: QueryClient;
  let invalidate: { mock: { calls: unknown[][] }; mockClear: () => void };
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const invalidatedKeys = () => invalidate.mock.calls.map((call: unknown[]) => (call[0] as { queryKey: unknown }).queryKey);

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    client = new QueryClient();
    invalidate = vi.spyOn(client, "invalidateQueries") as unknown as typeof invalidate;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("listens on the plugin's backlog stream for the company", () => {
    renderHook(() => useBacklogLiveUpdates("plugin-1", "co-1"), { wrapper });
    expect(FakeEventSource.instances[0]!.url).toBe("/api/plugins/plugin-1/bridge/stream/backlog?companyId=co-1");
  });

  it("re-reads the backlog once for a burst of changes", () => {
    renderHook(() => useBacklogLiveUpdates("plugin-1", "co-1"), { wrapper });
    const source = FakeEventSource.instances[0]!;
    act(() => {
      source.send({ type: "changed", reason: "work-item", workItemId: 1 });
      source.send({ type: "changed", reason: "work-item", workItemId: 2 });
      source.send({ type: "something-else" });
    });
    expect(invalidate).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(BACKLOG_LIVE_DEBOUNCE_MS));
    expect(invalidatedKeys()).toEqual([queryKeys.backlog.list("co-1")]);
  });

  it("on a work item page, also re-reads that item when the change is about it", () => {
    renderHook(() => useBacklogLiveUpdates("plugin-1", "co-1", 7), { wrapper });
    const source = FakeEventSource.instances[0]!;
    act(() => source.send({ type: "changed", reason: "work-item", workItemId: 8 }));
    act(() => void vi.advanceTimersByTime(BACKLOG_LIVE_DEBOUNCE_MS));
    expect(invalidatedKeys()).toEqual([queryKeys.backlog.list("co-1")]);
    invalidate.mockClear();
    act(() => source.send({ type: "changed", reason: "task", workItemId: 7 }));
    act(() => void vi.advanceTimersByTime(BACKLOG_LIVE_DEBOUNCE_MS));
    expect(invalidatedKeys()).toEqual([queryKeys.backlog.list("co-1"), queryKeys.backlog.workItem("co-1", 7)]);
  });

  it("closes the stream when the page goes away", () => {
    const { unmount } = renderHook(() => useBacklogLiveUpdates("plugin-1", "co-1"), { wrapper });
    unmount();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  it("does nothing without a plugin or company", () => {
    renderHook(() => useBacklogLiveUpdates(null, "co-1"), { wrapper });
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
