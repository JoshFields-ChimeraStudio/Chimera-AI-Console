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
