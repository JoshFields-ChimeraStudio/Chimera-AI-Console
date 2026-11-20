/**
 * The API-price estimate for usage billed some other way (a Claude subscription). Chimera fork,
 * BACKLOG D9: one rate card for the Costs page, budgets that count the estimate, and the ADO
 * plugin's cost per Feature. Not the billing path: real API receipts are priced in
 * server/src/services/anthropic-pricing.ts.
 *
 * Standard global API list prices in USD per million tokens, checked 20 November 2026 against
 * https://platform.claude.com/docs/en/about-claude/pricing. Update here when prices change.
 * Uncached input includes cache writes, which the API bills at 1.25x (5-minute) or 2x (1-hour)
 * input; they are priced as plain input, so the input part of an estimate can be a little low.
 */
export const API_RATE_CARD_CHECKED = "2026-11-20";

export interface ApiRate {
  /** Model name; also matches dated and provider-prefixed names (claude-haiku-4-5-20251001, anthropic/claude-sonnet-5-5). */
  model: string;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  note?: string;
}

export const API_RATE_CARD: readonly ApiRate[] = [
  { model: "claude-fable-5-2", inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 50, note: "assumed the same as Fable 5.1" },
  { model: "claude-fable-5-1", inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 50 },
  { model: "claude-mythos-5", inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 50 },
  { model: "claude-opus-5-5", inputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 20 },
  { model: "claude-opus-5", inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 25 },
  { model: "claude-sonnet-5-5", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 10 },
  { model: "claude-sonnet-5", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 10 },
  { model: "claude-haiku-5-5", inputUsdPerMillion: 0.1, cachedInputUsdPerMillion: 0.01, outputUsdPerMillion: 0.5, note: "prompts up to 100K tokens; longer prompts cost 5x" },
  { model: "claude-haiku-4-5", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 5 },
];

/** The bare model name: lower case, without a provider prefix. */
export function bareModelName(model: string): string {
  return model.trim().toLowerCase().replace(/^.*\//, "");
}

/** The rate for a model, the longest matching name winning (claude-sonnet-5-5 is not claude-sonnet-5), or null. */
export function apiRateFor(model: string): ApiRate | null {
  const m = bareModelName(model);
  let best: ApiRate | null = null;
  for (const rate of API_RATE_CARD) {
    const name = rate.model;
    if ((m === name || m.startsWith(`${name}-`) || m.startsWith(`${name}@`)) && (!best || name.length > best.model.length)) best = rate;
  }
  return best;
}

/** The estimate in cents (fractional), or null for a model with no rate. */
export function apiEstimateCents(model: string, inputTokens: number, cachedInputTokens: number, outputTokens: number): number | null {
  const rate = apiRateFor(model);
  if (!rate) return null;
  return (inputTokens * rate.inputUsdPerMillion + cachedInputTokens * rate.cachedInputUsdPerMillion + outputTokens * rate.outputUsdPerMillion) / 10_000;
}
