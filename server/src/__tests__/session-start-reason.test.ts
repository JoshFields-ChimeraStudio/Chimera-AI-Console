import { describe, expect, it } from "vitest";
import { describeSessionStart } from "../services/heartbeat/run-state.ts";

const base = {
  contextSnapshot: { wakeReason: "ado_child_changed" },
  taskSessionAvailable: true,
  taskSessionReused: true,
  configResetReason: null,
  compaction: { rotate: false, reason: null },
};

describe("describeSessionStart (fork patch: session reasons in the run ledger)", () => {
  it("resumes the task's session when it is reused", () => {
    expect(describeSessionStart(base)).toEqual({ resumedTaskSession: true, reason: null });
  });

  it("names the first run on a task", () => {
    expect(describeSessionStart({ ...base, taskSessionAvailable: false, taskSessionReused: false })).toEqual({
      resumedTaskSession: false,
      reason: "no saved session for this task yet",
    });
  });

  it("names a rotation, even when the task session was otherwise reusable", () => {
    expect(describeSessionStart({ ...base, compaction: { rotate: true, reason: "session exceeded 200 runs" } }).reason).toBe(
      "the session was rotated: session exceeded 200 runs",
    );
  });

  it("names a fresh start the wake asked for, then a workspace change, then a configuration change", () => {
    const fresh = { ...base, taskSessionReused: false };
    expect(describeSessionStart({ ...fresh, contextSnapshot: { forceFreshSession: true } }).reason).toBe("forceFreshSession was requested");
    expect(describeSessionStart({ ...fresh, contextSnapshot: { workspaceSelectionChanged: true } }).reason).toBe(
      "the task's workspace selection changed",
    );
    expect(describeSessionStart({ ...fresh, configResetReason: "managed instructions changed" }).reason).toBe(
      "the agent's configuration changed (managed instructions changed)",
    );
    expect(describeSessionStart(fresh).reason).toBe("the saved session could not be reused");
  });
});
