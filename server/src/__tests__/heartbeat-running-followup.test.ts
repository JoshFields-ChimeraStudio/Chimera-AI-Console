import { describe, expect, it } from "vitest";
import { shouldQueueFollowupForRunningIssueWake } from "../services/heartbeat.ts";

describe("shouldQueueFollowupForRunningIssueWake", () => {
  it("preserves a deferred fallback while the source turn is still running", () => {
    expect(shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: {
        wakeReason: "issue_commented",
        interactionId: "00000000-0000-4000-8000-000000000001",
        interactionStatus: "accepted",
      },
      wakeCommentId: null,
    })).toBe(true);
  });

  it("still coalesces a generic issue wake without new input", () => {
    expect(shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: { wakeReason: "issue_commented" },
      wakeCommentId: null,
    })).toBe(false);
  });

  it("queues a plugin wake behind a running turn instead of merging it", () => {
    expect(shouldQueueFollowupForRunningIssueWake({
      contextSnapshot: { wakeReason: "ado_child_changed", pluginId: "plugin-1", source: "ado.work-item" },
      wakeCommentId: null,
    })).toBe(true);
  });
});
