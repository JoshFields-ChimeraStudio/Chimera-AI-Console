/**
 * Which ADO tools each agent may use. The one place agent permissions for ADO
 * live (doc/plans/2026-11-14-ado-integration.md, "A8"). All agents share one
 * ADO service account, so ADO itself cannot tell them apart; this table can.
 */
import { TOOL_NAMES, type AdoToolName } from "./definitions.js";

export const ROLES = ["readonly", "builder", "reviewer", "planner"] as const;
export type AdoRole = (typeof ROLES)[number];

export interface RolePolicy {
  tools: readonly AdoToolName[];
  /** Work item types the role may create with ado_create_child_work_item; "*" means any. */
  createTypes: readonly string[] | "*";
}

const T = TOOL_NAMES;

export const ROLE_POLICIES: Record<AdoRole, RolePolicy> = {
  readonly: { tools: [T.getWorkItem], createTypes: [] },
  builder: {
    tools: [T.getWorkItem, T.addComment, T.setState, T.linkPullRequest, T.createChildWorkItem],
    // Bugs are for problems found in production and are entered by Josh or a planner;
    // review failures go back through PR comments and the story's state, not new items.
    createTypes: ["Task"],
  },
  reviewer: { tools: [T.getWorkItem, T.addComment, T.setState], createTypes: [] },
  planner: {
    tools: [T.getWorkItem, T.addComment, T.setState, T.linkPullRequest, T.createChildWorkItem],
    createTypes: "*",
  },
};

export const DEFAULT_ROLE: AdoRole = "readonly";

export interface AgentRoleEntry {
  agent?: unknown;
  role?: unknown;
  /** Optional: pins the entry to one agent. Always wins over the name. */
  agentId?: unknown;
}

/**
 * Name to agent id, recorded the first time a name entry is used
 * (trust on first use). Agent names are unique only among live agents, so
 * without this a newly hired or renamed agent could take a former agent's
 * name, and its role.
 */
export type RoleBindings = Record<string, string>;

export interface RoleBindingStore {
  load(): Promise<RoleBindings>;
  save(bindings: RoleBindings): Promise<void>;
}

export interface RoleDecision {
  role: AdoRole;
  /** Why a listed agent was given readonly instead of its listed role. */
  downgraded?: string;
}

function isRole(value: unknown): value is AdoRole {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

function entries(agentRoles: unknown): Array<{ name: string; role: AdoRole; agentId: string | null }> {
  if (!Array.isArray(agentRoles)) return [];
  const out = [];
  for (const e of agentRoles as AgentRoleEntry[]) {
    if (typeof e?.agent !== "string" || !e.agent.trim() || !isRole(e.role)) continue;
    const agentId = typeof e.agentId === "string" && e.agentId.trim() ? e.agentId.trim() : null;
    out.push({ name: e.agent.trim().toLowerCase(), role: e.role, agentId });
  }
  return out;
}

/** Bindings for names that are no longer listed (or are pinned by id) are dropped, so remove-and-re-add resets one. */
export function pruneBindings(agentRoles: unknown, bindings: RoleBindings): RoleBindings {
  const named = new Set(entries(agentRoles).filter((e) => !e.agentId).map((e) => e.name));
  return Object.fromEntries(Object.entries(bindings).filter(([name]) => named.has(name)));
}

/** The role for an agent from the `agentRoles` setting. Unknown agents are readonly. */
export async function resolveRole(
  agentRoles: unknown,
  agent: { id: string; name: string } | null,
  store: RoleBindingStore,
): Promise<RoleDecision> {
  if (!agent) return { role: DEFAULT_ROLE };
  const list = entries(agentRoles);
  const pinned = list.find((e) => e.agentId === agent.id);
  if (pinned) return { role: pinned.role };
  const name = agent.name.trim().toLowerCase();
  const entry = list.find((e) => e.name === name);
  if (!entry) return { role: DEFAULT_ROLE };
  if (entry.agentId) {
    return { role: DEFAULT_ROLE, downgraded: `the "${agent.name}" entry is pinned to a different agent id` };
  }
  const bindings = pruneBindings(agentRoles, await store.load());
  const bound = bindings[name];
  if (bound && bound !== agent.id) {
    return {
      role: DEFAULT_ROLE,
      downgraded:
        `the "${agent.name}" entry was first used by a different agent (${bound}); ` +
        `the board can reset it by removing the entry, saving, and adding it again, or by setting agentId on it`,
    };
  }
  if (!bound) await store.save({ ...bindings, [name]: agent.id });
  return { role: entry.role };
}

export function roleAllows(role: AdoRole, tool: AdoToolName): boolean {
  return ROLE_POLICIES[role].tools.includes(tool);
}

export function roleMayCreate(role: AdoRole, type: string): boolean {
  const allowed = ROLE_POLICIES[role].createTypes;
  return allowed === "*" || allowed.some((t) => t.toLowerCase() === type.toLowerCase());
}
