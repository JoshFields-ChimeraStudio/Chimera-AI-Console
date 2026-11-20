/**
 * D9: the cost of a Feature or Epic, written to ADO when it is Completed.
 *
 * The cost is everything Paperclip recorded for the item's linked task and every task under it
 * (Stories, Reviews, QA Tests, Defects, Documents...), split by agent and model (fork patch 16).
 * On the subscription the billed cost is $0, so the report also prices the same tokens at the
 * API rate card below: an estimate to judge whether the API or the subscription is cheaper.
 *
 * Costs are recorded when a run finishes, after its status, and the run that completed the last
 * Story is often still going when the Feature completes. So the report waits until no run under
 * the item is queued or running and the last one finished a little while ago, checking again
 * every minute (pending reports survive a restart).
 */
import type { Issue, PluginContext, PluginIssueCostBreakdownRow } from "@paperclipai/plugin-sdk";
import type { WorkItemSummary } from "../ado/client.js";
import type { PluginDeps } from "../deps.js";
import { attributedHtml } from "../tools/html.js";
import { PLUGIN_SIGNATURE } from "../workflow/rules.js";

/** The types that get a cost report when they complete. */
export const COST_REPORT_TYPES = ["feature", "epic"];

/**
 * API list prices in USD per million tokens: [input, cache read, output]. Standard global API pricing,
 * checked 20 November 2026 against https://platform.claude.com/docs/en/about-claude/pricing and its
 * reporting (Sonnet 5.5 cache reads $0.10 since Haiku 5.5 shipped). Update here when prices change.
 * Uncached input includes cache writes, which the API bills at 1.25x (5-minute) or 2x (1-hour) input:
 * they are priced as plain input, so the input part of an estimate can be low by up to that much.
 */
export const API_RATES: Record<string, readonly [number, number, number]> = {
  "claude-fable-5-2": [10, 1, 50], // assumed the same as Fable 5.1
  "claude-fable-5-1": [10, 1, 50],
  "claude-mythos-5": [10, 1, 50],
  "claude-opus-5-5": [4, 0.2, 20],
  "claude-opus-5": [5, 0.5, 25],
  "claude-sonnet-5-5": [2, 0.1, 10],
  "claude-sonnet-5": [2, 0.2, 10],
  "claude-haiku-5-5": [0.1, 0.01, 0.5], // prompts up to 100K tokens; longer prompts cost 5x
  "claude-haiku-4-5": [1, 0.1, 5],
};

/** The rate for a model, matching dated or prefixed names (claude-haiku-4-5-20251001, anthropic/claude-sonnet-5-5). */
export function rateFor(model: string): readonly [number, number, number] | null {
  const m = model.trim().toLowerCase().replace(/^.*\//, "");
  let best: string | null = null;
  for (const name of Object.keys(API_RATES)) {
    if ((m === name || m.startsWith(`${name}-`) || m.startsWith(`${name}@`)) && (!best || name.length > best.length)) best = name;
  }
  return best ? API_RATES[best]! : null;
}

export interface CostLine {
  label: string;
  events: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  billedUsd: number;
  apiUsd: number | null;
}

export interface CostReport {
  total: CostLine;
  byAgent: CostLine[];
  byModel: CostLine[];
  /** Models with no API rate: their tokens are not in the estimate. */
  unpricedModels: string[];
}

function apiUsd(row: PluginIssueCostBreakdownRow): number | null {
  const rate = rateFor(row.model);
  if (!rate) return null;
  return (row.inputTokens * rate[0] + row.cachedInputTokens * rate[1] + row.outputTokens * rate[2]) / 1_000_000;
}

function emptyLine(label: string): CostLine {
  return { label, events: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, billedUsd: 0, apiUsd: null };
}

function add(line: CostLine, row: PluginIssueCostBreakdownRow, api: number | null): void {
  line.events += row.events;
  line.inputTokens += row.inputTokens;
  line.cachedInputTokens += row.cachedInputTokens;
  line.outputTokens += row.outputTokens;
  line.billedUsd += row.costCents / 100;
  // Tokens of a model with no rate stay out of the estimate (and are listed under it).
  if (api !== null) line.apiUsd = (line.apiUsd ?? 0) + api;
}

export function buildCostReport(rows: PluginIssueCostBreakdownRow[], agentNames: Map<string, string>): CostReport {
  const total = emptyLine("Total");
  const byAgent = new Map<string, CostLine>();
  const byModel = new Map<string, CostLine>();
  const unpriced = new Set<string>();
  for (const row of rows) {
    const api = apiUsd(row);
    if (api === null) unpriced.add(row.model);
    const agent = row.agentId ? (agentNames.get(row.agentId) ?? "Unknown agent") : "No agent";
    if (!byAgent.has(agent)) byAgent.set(agent, emptyLine(agent));
    if (!byModel.has(row.model)) byModel.set(row.model, emptyLine(row.model));
    add(total, row, api);
    add(byAgent.get(agent)!, row, api);
    add(byModel.get(row.model)!, row, api);
  }
  const order = (a: CostLine, b: CostLine) => (b.apiUsd ?? 0) - (a.apiUsd ?? 0) || b.outputTokens - a.outputTokens;
  return { total, byAgent: [...byAgent.values()].sort(order), byModel: [...byModel.values()].sort(order), unpricedModels: [...unpriced].sort() };
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

function usd(n: number | null): string {
  if (n === null) return "n/a";
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

function lineText(l: CostLine): string {
  return `${l.label}: ${usd(l.apiUsd)} at API prices (billed ${usd(l.billedUsd)}); ${tokens(l.inputTokens)} input, ${tokens(l.cachedInputTokens)} cache reads, ${tokens(l.outputTokens)} output; ${l.events} runs`;
}

/** The report as plain text (one copy, for the ADO comment and the Paperclip task). */
export function costReportText(type: string, report: CostReport, taskCount: number): string {
  const t = report.total;
  const lines = [
    `Cost of this ${type}, from Paperclip's records for its task and the ${taskCount - 1} tasks under it:`,
    `- Billed: ${usd(t.billedUsd)}. At API prices it would have cost about ${usd(t.apiUsd)}.`,
    `- Tokens: ${tokens(t.inputTokens)} input, ${tokens(t.cachedInputTokens)} cache reads, ${tokens(t.outputTokens)} output, over ${t.events} runs.`,
    "",
    "By agent:",
    ...report.byAgent.map((l) => `- ${lineText(l)}`),
    "",
    "By model:",
    ...report.byModel.map((l) => `- ${lineText(l)}`),
    "",
    "The API price is an estimate from the ADO plugin's rate card (standard API prices; cache writes priced as plain input, so it can be a little low). It is not an invoice.",
  ];
  if (report.unpricedModels.length) lines.push(`Not in the estimate (no API price known): ${report.unpricedModels.join(", ")}.`);
  return lines.join("\n");
}

interface PendingReport {
  companyId: string;
  workItemId: number;
  type: string;
  issueId: string;
  attempts: number;
}

export interface CostReporterOptions {
  deps: PluginDeps;
  /** Delay between checks (default one minute). */
  retryMs?: number;
  /** How long after the last run finished before costs are taken as recorded (default one minute). */
  settleMs?: number;
  /** Checks before reporting anyway, with a note (default 120: two hours at one a minute). */
  maxAttempts?: number;
  /** Timer, swappable in tests. */
  schedule?: (fn: () => void, ms: number) => void;
}

const PENDING_INDEX = "cost-reports-pending";
const DONE_PREFIX = "cost-report-done";

export function createCostReporter(options: CostReporterOptions) {
  const { deps } = options;
  const ctx: PluginContext = deps.ctx;
  const retryMs = options.retryMs ?? 60_000;
  const settleMs = options.settleMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 120;
  const schedule = options.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.());
  const indexScope = { scopeKind: "instance" as const, stateKey: PENDING_INDEX };
  const doneScope = (companyId: string, id: number) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: `${DONE_PREFIX}:${id}` });

  async function readPending(): Promise<PendingReport[]> {
    return ((await ctx.state.get(indexScope)) as PendingReport[] | null) ?? [];
  }
  async function writePending(list: PendingReport[]): Promise<void> {
    await ctx.state.set(indexScope, list);
  }
  const same = (a: PendingReport, b: { companyId: string; workItemId: number }) => a.companyId === b.companyId && a.workItemId === b.workItemId;

  async function agentNames(companyId: string): Promise<Map<string, string>> {
    const agents = await ctx.agents.list({ companyId, limit: 500 }).catch(() => []);
    return new Map(agents.map((a) => [a.id, a.name]));
  }

  /** One check: report if the item's runs are all finished and settled, otherwise try again later. Returns what happened. */
  async function check(p: PendingReport): Promise<"reported" | "waiting" | "dropped"> {
    if (await ctx.state.get(doneScope(p.companyId, p.workItemId))) {
      await writePending((await readPending()).filter((x) => !same(x, p)));
      return "dropped";
    }
    const summary = await ctx.issues.summaries.getOrchestration({ issueId: p.issueId, companyId: p.companyId, includeSubtree: true });
    const active = summary.runs.filter((r) => r.status === "queued" || r.status === "running");
    const lastFinished = Math.max(0, ...summary.runs.map((r) => (r.finishedAt ? Date.parse(r.finishedAt) : 0)));
    const unsettled = active.length > 0 || deps.now() - lastFinished < settleMs;
    if (unsettled && p.attempts + 1 < maxAttempts) {
      const next = { ...p, attempts: p.attempts + 1 };
      await writePending((await readPending()).map((x) => (same(x, p) ? next : x)));
      schedule(() => void run(next), retryMs);
      return "waiting";
    }
    const report = buildCostReport(summary.costs.breakdown ?? [], await agentNames(p.companyId));
    let text = costReportText(p.type, report, summary.subtreeIssueIds.length);
    if (active.length) text += `\n${active.length} run(s) were still going when this was written; their cost is not included.`;
    const ado = await deps.adoClient(p.companyId);
    await ado.addComment(p.workItemId, attributedHtml(PLUGIN_SIGNATURE, text));
    await ctx.issues.createComment(p.issueId, text, p.companyId).catch(() => undefined);
    await ctx.state.set(doneScope(p.companyId, p.workItemId), { at: new Date(deps.now()).toISOString(), apiUsd: report.total.apiUsd });
    await writePending((await readPending()).filter((x) => !same(x, p)));
    ctx.logger.info("ADO cost report written", { companyId: p.companyId, workItemId: p.workItemId, apiUsd: report.total.apiUsd });
    return "reported";
  }

  async function run(p: PendingReport): Promise<void> {
    try {
      await check(p);
    } catch (err) {
      ctx.logger.warn("ADO cost report failed; trying again", { workItemId: p.workItemId, error: err instanceof Error ? err.message : String(err) });
      if (p.attempts + 1 < maxAttempts) {
        const next = { ...p, attempts: p.attempts + 1 };
        await writePending((await readPending()).map((x) => (same(x, p) ? next : x))).catch(() => undefined);
        schedule(() => void run(next), retryMs);
      }
    }
  }

  /** Watcher hook: a Feature or Epic was Completed and its task closed. */
  async function onCompleted(companyId: string, item: WorkItemSummary, task: Issue): Promise<void> {
    if (!COST_REPORT_TYPES.includes(item.type.trim().toLowerCase())) return;
    if (await ctx.state.get(doneScope(companyId, item.id))) return;
    const pending = await readPending();
    if (pending.some((x) => same(x, { companyId, workItemId: item.id }))) return;
    const p: PendingReport = { companyId, workItemId: item.id, type: item.type, issueId: task.id, attempts: 0 };
    await writePending([...pending, p]);
    schedule(() => void run(p), retryMs);
  }

  /** On startup: pick up reports a restart interrupted. */
  async function resume(): Promise<number> {
    const pending = await readPending();
    for (const p of pending) schedule(() => void run(p), retryMs);
    return pending.length;
  }

  return { onCompleted, resume, check };
}

export type CostReporter = ReturnType<typeof createCostReporter>;
