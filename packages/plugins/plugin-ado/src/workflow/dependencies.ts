/**
 * A11: dependencies between work items as real ADO links. "B depends on A" is a Predecessor link
 * on B to A (ADO's System.LinkTypes.Dependency-Reverse), which ADO shows on both items and in
 * Delivery Plans. The planner sets them with `dependsOn` on ado_create_work_item and
 * ado_update_work_item. Older items say "Depends on #<id>" in their description; routing (A6)
 * reads both.
 */
import type { AdoWorkItem } from "../ado/client.js";

/** On B, a link to A: A is B's predecessor (B depends on A). */
export const DEPENDS_ON_REL = "System.LinkTypes.Dependency-Reverse";

function idFrom(url: string): number | null {
  const m = url.match(/\/workItems\/(\d+)$/i);
  const id = m ? Number(m[1]) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The items this one depends on (its Predecessor links), in link order. */
export function predecessorsOf(item: Pick<AdoWorkItem, "relations">): number[] {
  const out: number[] = [];
  for (const r of item.relations ?? []) {
    if (r.rel !== DEPENDS_ON_REL) continue;
    const id = idFrom(r.url);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Index of each Predecessor link in the item's relations, for removing it with a JSON patch. */
export function predecessorIndexes(item: Pick<AdoWorkItem, "relations">): Map<number, number> {
  const out = new Map<number, number>();
  (item.relations ?? []).forEach((r, i) => {
    if (r.rel !== DEPENDS_ON_REL) return;
    const id = idFrom(r.url);
    if (id && !out.has(id)) out.set(id, i);
  });
  return out;
}
