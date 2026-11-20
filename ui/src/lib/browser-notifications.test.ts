import { describe, expect, it } from "vitest";
import { notificationMessages } from "./browser-notifications";

const badges = (over: Partial<{ approvals: number; failedRuns: number; unreadIssueIds: string[] }> = {}) => ({
  inbox: 0, approvals: 0, failedRuns: 0, joinRequests: 0, unreadIssueIds: [], ...over,
});

describe("browser notifications (D4)", () => {
  it("is quiet when nothing new arrived, including when counts fall", () => {
    expect(notificationMessages(badges({ approvals: 2, failedRuns: 1, unreadIssueIds: ["a"] }), badges({ approvals: 1, unreadIssueIds: ["a"] }), "Chimera")).toEqual([]);
  });

  it("tells about new approvals, failed runs and tasks waiting for you", () => {
    const messages = notificationMessages(
      badges({ approvals: 1, failedRuns: 0, unreadIssueIds: ["a"] }),
      badges({ approvals: 2, failedRuns: 2, unreadIssueIds: ["a", "b"] }),
      "Chimera",
    );
    expect(messages.map((m) => [m.tag, m.title, m.path])).toEqual([
      ["approvals", "Chimera: approval needed", "/approvals/pending"],
      ["failed-runs", "Chimera: 2 runs failed", "/inbox"],
      ["mine", "Chimera: a task is waiting for you", "/inbox"],
    ]);
    expect(messages[0].body).toBe("2 approvals are waiting for you.");
  });

  it("counts a task that was read and came back as new", () => {
    expect(notificationMessages(badges({ unreadIssueIds: ["a"] }), badges({ unreadIssueIds: ["b", "c"] }), "Chimera")[0].title)
      .toBe("Chimera: 2 tasks are waiting for you");
  });
});
