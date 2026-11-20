/**
 * SQL for the API-price estimate (Chimera fork, BACKLOG D9; rate card in
 * packages/shared/src/api-rate-card.ts). Used by the Costs page, the cost
 * breakdown plugins read, and budgets with the api_estimate_cents metric.
 */
import { API_RATE_CARD } from "@paperclipai/shared";
import { sql, type SQL } from "drizzle-orm";
import { costEvents } from "@paperclipai/db";
import { ordinaryInputTokens } from "./costs.js";

/** Billing type the estimate prices: usage a subscription covers, billed at $0. Overage and
 * metered usage already carry a real bill, so the estimate keeps their billed cost. */
export const SUBSCRIPTION_INCLUDED = "subscription_included";

/** A cost event's tokens at API list prices, in cents (numeric), or NULL for a model with no rate. */
export function apiEstimateCentsSql(): SQL<string | null> {
  // Longest names first, so claude-sonnet-5-5 is not priced as claude-sonnet-5.
  const rates = [...API_RATE_CARD].sort((a, b) => b.model.length - a.model.length);
  const bare = sql`lower(regexp_replace(${costEvents.model}, '^.*/', ''))`;
  const cases = rates.map((r) => {
    // USD per million tokens to cents per token: x / 1,000,000 * 100.
    const per = (usd: number) => sql.raw(`${(usd / 10_000).toFixed(12)}::numeric`);
    return sql`when ${bare} = ${r.model} or ${bare} like ${`${r.model}-%`} or ${bare} like ${`${r.model}@%`}
      then (${ordinaryInputTokens})::numeric * ${per(r.inputUsdPerMillion)} + (${costEvents.cachedInputTokens})::numeric * ${per(r.cachedInputUsdPerMillion)}
        + (${costEvents.outputTokens})::numeric * ${per(r.outputUsdPerMillion)}`;
  });
  return sql<string | null>`(case ${sql.join(cases, sql` `)} else null end)`;
}

/** Cents a cost event counts for in the estimate: the API-price estimate for subscription-included
 * usage (billed cost when its model has no rate), and billed cost for everything else. */
export function apiEstimateSpendCentsSql(): SQL<string> {
  return sql<string>`(case when ${costEvents.billingType} = ${SUBSCRIPTION_INCLUDED}
    then coalesce(${apiEstimateCentsSql()}, ${costEvents.costCents}) else ${costEvents.costCents} end)`;
}
