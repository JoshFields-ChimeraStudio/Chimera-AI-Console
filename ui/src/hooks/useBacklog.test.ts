import { describe, expect, it } from "vitest";
import {
  BACKLOG_POLL_MAX_BACKOFF_MS,
  BACKLOG_POLL_MAX_ERRORS,
  BACKLOG_SYNC_POLL_MS,
  backlogPollInterval,
  consecutiveErrors,
  findReadyAdoPlugin,
} from "./useBacklog";

describe("backlogPollInterval", () => {
  it("polls only while a sync is running or awaited", () => {
    expect(backlogPollInterval(false, 0)).toBe(false);
    expect(backlogPollInterval(true, 0)).toBe(BACKLOG_SYNC_POLL_MS);
  });

  it("backs off after failed polls and stops after too many", () => {
    expect(backlogPollInterval(true, 1)).toBe(BACKLOG_SYNC_POLL_MS * 2);
    expect(backlogPollInterval(true, 2)).toBe(BACKLOG_SYNC_POLL_MS * 4);
    expect(backlogPollInterval(true, BACKLOG_POLL_MAX_ERRORS - 1)).toBe(BACKLOG_POLL_MAX_BACKOFF_MS);
    expect(backlogPollInterval(true, BACKLOG_POLL_MAX_ERRORS)).toBe(false);
  });
});

describe("consecutiveErrors", () => {
  it("counts failures since the last success and resets on success or a user reset", () => {
    const baseline = { current: 0 };
    expect(consecutiveErrors({ errorUpdateCount: 0, errorUpdatedAt: 0, dataUpdatedAt: 10 }, baseline)).toBe(0);
    expect(consecutiveErrors({ errorUpdateCount: 3, errorUpdatedAt: 40, dataUpdatedAt: 10 }, baseline)).toBe(3);
    // The user presses Sync or Retry: the baseline moves to the current count.
    baseline.current = 3;
    expect(consecutiveErrors({ errorUpdateCount: 4, errorUpdatedAt: 50, dataUpdatedAt: 10 }, baseline)).toBe(1);
    // A success resets the count.
    expect(consecutiveErrors({ errorUpdateCount: 4, errorUpdatedAt: 50, dataUpdatedAt: 60 }, baseline)).toBe(0);
    expect(baseline.current).toBe(4);
    expect(consecutiveErrors({ errorUpdateCount: 5, errorUpdatedAt: 70, dataUpdatedAt: 60 }, baseline)).toBe(1);
  });
});

describe("findReadyAdoPlugin", () => {
  it("finds the ADO plugin by key only when ready", () => {
    const plugins = [
      { id: "a", pluginKey: "chimera.plugin-ado", status: "error" },
      { id: "b", pluginKey: "other", status: "ready" },
    ] as never[];
    expect(findReadyAdoPlugin(plugins)).toBeNull();
    expect(findReadyAdoPlugin([{ id: "c", pluginKey: "chimera.plugin-ado", status: "ready" }] as never[])?.id).toBe("c");
  });
});
