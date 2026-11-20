import { describe, expect, it } from "vitest";
import type { PluginIssueCostBreakdownRow } from "@paperclipai/plugin-sdk";
import { buildCostReport, costReportText, createCostReporter } from "../src/costs/index.js";

const row = (over: Partial<PluginIssueCostBreakdownRow>): PluginIssueCostBreakdownRow => ({
  agentId: "a-maple",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  billingType: "subscription_included",
  events: 1,
  costCents: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  ...over,
});

describe("cost per Feature (D9)", () => {
  it("adds up the server's API estimate and splits it by agent and model", () => {
    const names = new Map([["a-maple", "Maple"], ["a-rowan", "Rowan"]]);
    const report = buildCostReport(
      [
        // The server prices each row (fork patch 17); the plugin only adds the estimates up.
        row({ agentId: "a-maple", events: 3, inputTokens: 1_000_000, cachedInputTokens: 10_000_000, outputTokens: 100_000, apiEstimateCents: 400 }),
        row({ agentId: "a-rowan", model: "claude-haiku-4-5-20251001", events: 2, inputTokens: 2_000_000, outputTokens: 200_000, apiEstimateCents: 300 }),
        // Billed on the API: the estimate is the billed cost.
        row({ agentId: "a-rowan", billingType: "metered_api", costCents: 150, events: 1, inputTokens: 500_000, apiEstimateCents: 150 }),
        // No rate (null from the server): left out of the estimate, and named.
        row({ agentId: null, model: "mystery-1", events: 1, inputTokens: 999, apiEstimateCents: null }),
      ],
      names,
    );
    expect(report.total.events).toBe(7);
    expect(report.total.apiUsd).toBeCloseTo(4 + 3 + 1.5);
    expect(report.total.billedUsd).toBeCloseTo(1.5);
    expect(report.byAgent.map((l) => [l.label, Number(l.apiUsd?.toFixed(2))])).toEqual([["Rowan", 4.5], ["Maple", 4], ["No agent", NaN]]);
    expect(report.byModel.find((l) => l.label === "mystery-1")?.apiUsd).toBeNull();
    expect(report.unpricedModels).toEqual(["mystery-1"]);

    const text = costReportText("Feature", report, 6);
    expect(text).toContain("Cost of this Feature, from Paperclip's records for its task and the 5 tasks under it:");
    expect(text).toContain("- Billed: $1.50. At API prices it would have cost about $8.50.");
    expect(text).toContain("Maple: $4.00 at API prices (billed $0.00); 1.0M input, 10.0M cache reads, 100k output; 3 runs");
    expect(text).toContain("Not in the estimate (no API price known): mystery-1.");
  });

  describe("reporter", () => {
    function setup(runs: Array<{ status: string; finishedAt: string | null }>) {
      let now = Date.parse("2026-11-20T12:00:00Z");
      const state = new Map<string, unknown>();
      const keyOf = (s: { scopeKind: string; scopeId?: string; stateKey: string }) => `${s.scopeKind}:${s.scopeId ?? ""}:${s.stateKey}`;
      const timers: Array<() => void> = [];
      const adoComments: Array<{ id: number; html: string }> = [];
      const taskComments: string[] = [];
      const summary = {
        runs,
        subtreeIssueIds: ["t-feature", "t-story", "t-review"],
        costs: { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, billingCode: null, breakdown: [row({ inputTokens: 1_000_000, apiEstimateCents: 200 })] },
      };
      const ctx = {
        state: {
          get: async (s: never) => state.get(keyOf(s)) ?? null,
          set: async (s: never, v: unknown) => void state.set(keyOf(s), v),
        },
        issues: {
          summaries: { getOrchestration: async () => summary },
          createComment: async (_id: string, body: string) => void taskComments.push(body),
        },
        agents: { list: async () => [{ id: "a-maple", name: "Maple" }] },
        logger: { info() {}, warn() {} },
      };
      const deps = {
        ctx,
        now: () => now,
        adoClient: async () => ({ addComment: async (id: number, html: string) => void adoComments.push({ id, html }) }),
      };
      const reporter = createCostReporter({ deps: deps as never, schedule: (fn) => void timers.push(fn), retryMs: 60_000, settleMs: 60_000, maxAttempts: 3 });
      const tick = async () => {
        const fn = timers.shift();
        fn?.();
        await new Promise((r) => setTimeout(r, 0));
      };
      const item = { id: 851, type: "Feature", title: "Add file", state: "Completed" } as never;
      const task = { id: "t-feature" } as never;
      return { reporter, timers, tick, adoComments, taskComments, summary, item, task, advance: (ms: number) => (now += ms) };
    }

    it("waits for running runs and the settle time, then writes one report to ADO and the task", async () => {
      const s = setup([{ status: "running", finishedAt: null }]);
      await s.reporter.onCompleted("co", s.item, s.task);
      await s.reporter.onCompleted("co", s.item, s.task); // a second event does not queue a second report
      expect(s.timers).toHaveLength(1);
      await s.tick();
      expect(s.adoComments).toHaveLength(0); // still running

      s.summary.runs = [{ status: "succeeded", finishedAt: "2026-11-20T11:59:50Z" }];
      await s.tick();
      expect(s.adoComments).toHaveLength(0); // finished 10 seconds ago: costs may not be recorded yet

      s.advance(120_000);
      await s.tick();
      expect(s.adoComments).toEqual([{ id: 851, html: expect.stringContaining("[ADO plugin] Cost of this Feature") }]);
      expect(s.adoComments[0]!.html).toContain("At API prices it would have cost about $2.00.");
      expect(s.taskComments[0]).toContain("Maple: $2.00 at API prices");
      expect(s.timers).toHaveLength(0);

      // Completed again later (reopened and closed): no second report.
      await s.reporter.onCompleted("co", s.item, s.task);
      expect(s.timers).toHaveLength(0);
    });

    it("reports anyway after the last attempt, saying runs were still going", async () => {
      const s = setup([{ status: "running", finishedAt: null }]);
      await s.reporter.onCompleted("co", s.item, s.task);
      await s.tick();
      await s.tick();
      await s.tick();
      expect(s.adoComments).toHaveLength(1);
      expect(s.adoComments[0]!.html).toContain("1 run(s) were still going when this was written");
    });

    it("ignores types other than Feature and Epic, and resumes pending reports after a restart", async () => {
      const s = setup([]);
      await s.reporter.onCompleted("co", { id: 9, type: "User Story" } as never, s.task);
      expect(s.timers).toHaveLength(0);
      await s.reporter.onCompleted("co", s.item, s.task);
      s.timers.length = 0; // the process restarted before the timer fired
      expect(await s.reporter.resume()).toBe(1);
      s.advance(120_000);
      await s.tick();
      expect(s.adoComments).toHaveLength(1);
    });
  });
});
