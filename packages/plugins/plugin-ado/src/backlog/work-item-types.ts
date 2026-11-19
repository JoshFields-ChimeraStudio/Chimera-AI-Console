/**
 * Work item type colours and state categories, from ADO's work item types API
 * (one call returns every type of the project with its colour and states).
 * Cached per company and type for an hour: types change only when someone edits
 * the process. A type the cache does not know triggers a refetch (at most once
 * a minute), so a newly added type shows up without waiting for the hour.
 * Failures are remembered for a minute, so a full sync of thousands of items
 * does not call ADO for every item while the API is failing.
 */
import type { AdoClient, AdoWorkItemState } from "../ado/client.js";
import { toStateCategory, type StateCategory } from "./repository.js";

export const TYPE_CACHE_MS = 60 * 60 * 1000;
const REFETCH_MIN_MS = 60 * 1000;

interface TypeInfo {
  color: string | null;
  /** State name (lower case) to category; null until known. */
  states: Map<string, string> | null;
}

interface CompanyTypes {
  types: Map<string, TypeInfo>;
  fetchedAt: number;
  failedAt: number | null;
  inflight: Promise<void> | null;
}

export interface TypeLookup {
  typeColor: string | null;
  stateCategory: StateCategory | null;
}

export interface WorkItemTypeCache {
  lookup(companyId: string, ado: () => Promise<AdoClient>, type: string, state: string): Promise<TypeLookup>;
}

export function createWorkItemTypeCache(now: () => number, onError: (err: unknown) => void): WorkItemTypeCache {
  const companies = new Map<string, CompanyTypes>();

  function entry(companyId: string): CompanyTypes {
    let e = companies.get(companyId);
    if (!e) {
      e = { types: new Map(), fetchedAt: 0, failedAt: null, inflight: null };
      companies.set(companyId, e);
    }
    return e;
  }

  async function refresh(e: CompanyTypes, ado: () => Promise<AdoClient>): Promise<void> {
    if (e.inflight) return e.inflight;
    e.inflight = (async () => {
      try {
        const list = await (await ado()).listWorkItemTypes();
        e.types = new Map(list.map((t) => [t.name.toLowerCase(), { color: t.color, states: t.states ? stateMap(t.states) : null }]));
        e.fetchedAt = now();
        e.failedAt = null;
      } catch (err) {
        e.failedAt = now();
        onError(err);
      } finally {
        e.inflight = null;
      }
    })();
    return e.inflight;
  }

  return {
    async lookup(companyId, ado, type, state) {
      const e = entry(companyId);
      const t = now();
      const recentlyFailed = e.failedAt !== null && t - e.failedAt < REFETCH_MIN_MS;
      const stale = t - e.fetchedAt >= TYPE_CACHE_MS;
      const unknown = !e.types.has(type.toLowerCase()) && t - e.fetchedAt >= REFETCH_MIN_MS;
      if (!recentlyFailed && (stale || unknown)) await refresh(e, ado);

      const info = e.types.get(type.toLowerCase());
      if (!info) return { typeColor: null, stateCategory: null };
      if (!info.states && !(e.failedAt !== null && now() - e.failedAt < REFETCH_MIN_MS)) {
        // The type list did not include states: ask for this type's states (the call the A8 tools use).
        try {
          info.states = stateMap(await (await ado()).getWorkItemTypeStates(type));
        } catch (err) {
          e.failedAt = now();
          onError(err);
        }
      }
      return { typeColor: info.color, stateCategory: toStateCategory(info.states?.get(state.toLowerCase())) };
    },
  };
}

function stateMap(states: AdoWorkItemState[]): Map<string, string> {
  return new Map(states.map((s) => [s.name.toLowerCase(), s.category]));
}
