/**
 * Josh's instructions travel down the tree. A section that starts with a line "Instructions from Josh:"
 * (the last part of a description) on an Epic, Feature or Story is copied into the description of every
 * item created under it, so the reviewer reading only its Review, or QA reading only its QA Test, still
 * sees it. Agents were asked to copy it by hand and did not always do so (smoke test #848: the Feature
 * was created without it, so neither the Review nor the QA Test had it). The plugin now does it on
 * ado_create_work_item; an agent's own copy is kept and not repeated.
 */
import type { AdoWorkItem } from "../ado/client.js";
import { htmlToText } from "../tools/html.js";

export const INSTRUCTIONS_HEADING = "Instructions from Josh";

/** "Instructions from Josh:" or "Instructions from Josh (copied from #848):", with the text on the same line or the lines after. */
const HEADING = /^[ \t]*Instructions from Josh(?:\s*\(copied from #\d+\))?\s*:[ \t]*/im;

/** Types that do not take the instructions of the items above them. */
const NOT_CARRIED_TO = new Set(["epic", "bug", "defect"]);

/** How far up the tree to look (Review → Story → Feature → Epic is three). */
export const MAX_ANCESTORS = 5;

/** The text of an "Instructions from Josh:" section (to the end of the description), or null. */
export function extractInstructions(descriptionHtml: unknown): string | null {
  if (typeof descriptionHtml !== "string" || !descriptionHtml) return null;
  const text = htmlToText(descriptionHtml);
  const m = HEADING.exec(text);
  if (!m) return null;
  const body = text.slice(m.index + m[0].length).trim();
  return body || null;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface CarriedInstructions {
  /** The item whose description the text came from (the highest one, where it was first written). */
  sourceId: number;
  text: string;
}

/**
 * The distinct instruction sections of `ancestors` (nearest first, as read up the tree), highest first,
 * leaving out text an agent already wrote into `description`.
 */
export function instructionsToCarry(type: string, description: string | null, ancestors: AdoWorkItem[]): CarriedInstructions[] {
  if (NOT_CARRIED_TO.has(type.trim().toLowerCase())) return [];
  const have = normalize(description ?? "");
  const out: CarriedInstructions[] = [];
  const seen = new Set<string>();
  for (const item of [...ancestors].reverse()) {
    const text = extractInstructions(item.fields["System.Description"]);
    if (!text) continue;
    const key = normalize(text);
    if (seen.has(key) || have.includes(key)) continue;
    // A copy of a higher item's section (the plugin's or an agent's) is the same text: keep the first.
    if ([...seen].some((s) => s.includes(key) || key.includes(s))) continue;
    seen.add(key);
    out.push({ sourceId: item.id, text });
  }
  return out;
}

/** The description with the carried sections appended. */
export function withInstructions(description: string | null, carried: CarriedInstructions[]): string | null {
  if (!carried.length) return description;
  const sections = carried.map((c) => `${INSTRUCTIONS_HEADING} (copied from #${c.sourceId}):\n${c.text}`);
  return [description?.trim(), ...sections].filter(Boolean).join("\n\n");
}

/**
 * A new description for an item that keeps the item's "Instructions from Josh" section(s), when
 * the new text leaves them out (ado_update_work_item, A11): agents may rewrite a description,
 * not drop what Josh asked.
 */
export function keepInstructions(newDescription: string, currentHtml: unknown): string {
  if (typeof currentHtml !== "string" || !currentHtml) return newDescription;
  const text = htmlToText(currentHtml);
  const m = HEADING.exec(text);
  if (!m) return newDescription;
  const section = text.slice(m.index).trim();
  const body = extractInstructions(currentHtml);
  if (!body || normalize(newDescription).includes(normalize(body))) return newDescription;
  return `${newDescription.trim()}\n\n${section}`;
}
