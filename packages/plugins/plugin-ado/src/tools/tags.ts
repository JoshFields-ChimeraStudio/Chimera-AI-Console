/**
 * A7: the "agent:<Name>" tag records which agent last changed a work item.
 * All agents share one ADO service account, so ADO's own "Changed By" cannot.
 * ADO stores tags as one "; "-separated string; tags cannot contain ";" or ",".
 */

const AGENT_TAG_PREFIX = "agent:";

export function agentTag(agentName: string): string {
  const clean = agentName.replace(/[;,]/g, " ").replace(/\s+/g, " ").trim() || "unknown";
  return `${AGENT_TAG_PREFIX}${clean}`;
}

function splitTags(tags: unknown): string[] {
  return typeof tags === "string"
    ? tags
        .split(";")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
}

/** The tags with any previous agent tag replaced by this agent's. */
export function withAgentTag(currentTags: unknown, agentName: string): string {
  const kept = splitTags(currentTags).filter((t) => !t.toLowerCase().startsWith(AGENT_TAG_PREFIX));
  return [...kept, agentTag(agentName)].join("; ");
}

/** True when the item already carries exactly this agent's tag and no other agent tag. */
export function hasOnlyAgentTag(currentTags: unknown, agentName: string): boolean {
  const agentTags = splitTags(currentTags).filter((t) => t.toLowerCase().startsWith(AGENT_TAG_PREFIX));
  return agentTags.length === 1 && agentTags[0]!.toLowerCase() === agentTag(agentName).toLowerCase();
}

/** Tags the plugin manages through their own parameters (A7 agent, A12 repo, A6 builder and for). */
export const RESERVED_TAG_PREFIXES = ["agent:", "repo:", "builder:", "for:"] as const;

/** A tag as ADO can store it: no ";" or ",", single spaces. */
export function cleanTag(tag: string): string {
  return tag.replace(/[;,]/g, " ").replace(/\s+/g, " ").trim();
}

export function isReservedTag(tag: string): boolean {
  const t = tag.trim().toLowerCase();
  return RESERVED_TAG_PREFIXES.some((p) => t.startsWith(p));
}

/** The tags with `add` added (if missing) and `remove` taken out, case-insensitively. */
export function editTags(currentTags: unknown, add: string[], remove: string[]): string {
  const removing = new Set(remove.map((t) => cleanTag(t).toLowerCase()));
  const out = splitTags(currentTags).filter((t) => !removing.has(t.toLowerCase()));
  for (const t of add.map(cleanTag).filter(Boolean)) {
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.join("; ");
}
