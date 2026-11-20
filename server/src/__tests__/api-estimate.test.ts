// Chimera fork (BACKLOG D9, fork patch 17): the API-price estimate of subscription usage, as the
// Costs page, the subscription report, the plugin cost summary and api_estimate_cents budgets see it.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, budgetIncidents, budgetPolicies, companies, costEvents, createDb, type Db } from "@paperclipai/db";
import { apiEstimateCents } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { budgetService, computeObservedSpend, flushBudgetEvaluationWork } from "../services/budgets.js";
import { queueBudgetEvaluation } from "../services/budget-evaluation-work.js";
import { costService } from "../services/costs.js";
import { subscriptionCostReport } from "../services/subscription-report.js";

describe("api rate card", () => {
  it("prices dated and prefixed names, prefers the longest name, and has no rate for unknown models", () => {
    // 1M input * $2 + 10M cache reads * $0.10 + 0.1M output * $10 = $4
    expect(apiEstimateCents("claude-sonnet-5-5", 1_000_000, 10_000_000, 100_000)).toBeCloseTo(400);
    expect(apiEstimateCents("anthropic/claude-sonnet-5-5-20261001", 1_000_000, 10_000_000, 100_000)).toBeCloseTo(400);
    // claude-sonnet-5 has its own cache-read price ($0.20).
    expect(apiEstimateCents("claude-sonnet-5", 0, 1_000_000, 0)).toBeCloseTo(20);
    expect(apiEstimateCents("gpt-9", 1, 1, 1)).toBeNull();
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("API-price estimate (fork patch 17)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("api-estimate-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE companies CASCADE`);
  }); });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Estimate", issuePrefix: "EST" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Maple", role: "engineer", status: "active", adapterType: "process" });
    const occurredAt = new Date();
    const event = (over: Partial<typeof costEvents.$inferInsert>) => ({ companyId, agentId, provider: "anthropic", biller: "anthropic",
      billingType: "subscription_included", model: "claude-sonnet-5-5", costCents: 0, occurredAt, ...over });
    await db.insert(costEvents).values([
      // $4.00 at API prices, billed $0.
      event({ inputTokens: 1_000_000, cachedInputTokens: 10_000_000, outputTokens: 100_000 }),
      // Metered: the estimate is the billed cost, $1.50.
      event({ billingType: "metered_api", costCents: 150, inputTokens: 500_000 }),
      // No rate: billed cost ($0), and counted as unrated.
      event({ model: "mystery-1", inputTokens: 999 }),
    ]);
    return { companyId, agentId };
  }

  it("observes an api_estimate_cents budget at API prices and raises a hard incident", async () => {
    const { companyId } = await fixture();
    const [billed] = await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 500, notifyEnabled: false }).returning();
    const [estimate] = await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId,
      metric: "api_estimate_cents", windowKind: "lifetime", amount: 500 }).returning();
    expect((await computeObservedSpend(db, billed)).totalExact).toBe("150.0000000");
    expect((await computeObservedSpend(db, estimate)).totalExact).toBe("550.0000000");

    await db.transaction(tx => queueBudgetEvaluation(tx as unknown as Db, { companyId, agentId: null, projectId: null }));
    await flushBudgetEvaluationWork(db);
    const incidents = await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, companyId));
    expect(incidents.map(i => [i.policyId, i.thresholdType])).toEqual([[estimate.id, "hard"]]);
  });

  it("keeps the company's monthly budget field for the billed metric", async () => {
    const { companyId } = await fixture();
    await budgetService(db).upsertPolicy(companyId, { scopeType: "company", scopeId: companyId, metric: "api_estimate_cents",
      windowKind: "calendar_month_utc", amount: 10_000 }, null);
    let [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company.budgetMonthlyCents).toBe(0);
    await budgetService(db).upsertPolicy(companyId, { scopeType: "company", scopeId: companyId, metric: "billed_cents",
      windowKind: "calendar_month_utc", amount: 2_000 }, null);
    [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company.budgetMonthlyCents).toBe(2_000);
  });

  it("reports the estimate by agent and model, and in the subscription report", async () => {
    const { companyId } = await fixture();
    const rows = await costService(db).byAgentModel(companyId);
    const byKey = Object.fromEntries(rows.map(r => [`${r.billingType}:${r.model}`, r.apiEstimateCents]));
    expect(byKey["subscription_included:claude-sonnet-5-5"]).toBeCloseTo(400);
    expect(byKey["metered_api:claude-sonnet-5-5"]).toBeCloseTo(150);
    expect(byKey["subscription_included:mystery-1"]).toBe(0);
    const [agentRow] = await costService(db).byAgent(companyId);
    expect(agentRow.apiEstimateCents).toBeCloseTo(550);

    const report = await subscriptionCostReport(db, companyId, { userId: "nobody", canManage: false });
    expect(report.subscription.apiEstimateCents).toBe("400.0000000");
    expect(report.subscription.unratedEventCount).toBe(1);
    expect(report.api.apiEstimateCents).toBe("150.0000000");
  });
});
