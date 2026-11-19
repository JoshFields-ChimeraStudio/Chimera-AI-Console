/**
 * Decisions over the workflow rule tables (./rules.ts). Pure functions: the
 * caller gathers the facts (role, type, states, assignees) and gets back an
 * allow or a denial that names the rule and who may do it instead.
 * See doc/plans/2026-11-17-agent-workflow.md.
 */
import {
  ASSIGN_ANY_ROLES,
  ASSIGN_NONE_ROLES,
  ASSIGNMENT_RULES,
  APPROVED_STATE,
  BLOCKED_STATE,
  CHANGES_REQUESTED_STATE,
  CLAIM_TYPES,
  COMPLETED_STATE,
  DEFECT_TYPE,
  DOCUMENT_TYPE,
  IN_TESTING_STATE,
  PASSED_STATE,
  QA_TEST_TYPE,
  READY_FOR_RETEST_STATE,
  READY_FOR_REVIEW_STATE,
  READY_FOR_TEST_STATE,
  CREATION_RULES,
  FINAL_STATES,
  INITIAL_STATE,
  OTHER_TYPE_CREATION,
  OTHER_TYPE_STATES,
  READY_TO_MERGE_STATE,
  REVIEW_ROUND_LIMIT,
  REVIEW_TYPE,
  ROLE_DESCRIPTIONS,
  ROLES,
  STATE_RULES,
  type AdoRole,
  type AssignmentRuleId,
  type CreationRule,
  type Setter,
} from "./rules.js";

export * from "./rules.js";

export type Decision<R extends string = string> = { ok: true; rule: R } | { ok: false; rule: R; reason: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const includes = (list: readonly string[], value: string) => list.some((v) => same(v, value));

function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** "a Feature", "an Epic", "a User Story"; for a list, the article of its first item. */
function article(words: string): string {
  return /^[aeio]/i.test(words.trim()) ? `an ${words}` : `a ${words}`;
}

function roleList(roles: readonly AdoRole[]): string {
  return roles.length === 0 ? "no agent role" : `${joinOr(roles)} role${roles.length > 1 ? "s" : ""}`;
}

export function isRole(value: unknown): value is AdoRole {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Creating work items
// ---------------------------------------------------------------------------

export function creationRule(type: string): CreationRule | null {
  return CREATION_RULES.find((r) => same(r.type, type)) ?? null;
}

/** False for the types that have no parent (Epic, Bug). */
export function typeHasParent(type: string): boolean {
  const rule = creationRule(type);
  return !rule || rule.parentTypes !== null;
}

export function rolesThatMayCreate(type: string): readonly AdoRole[] {
  return creationRule(type)?.roles ?? OTHER_TYPE_CREATION.roles;
}

/** The types a role may create (listed types; "any other type" for a planner). */
export function typesRoleMayCreate(role: AdoRole): string[] {
  const listed = CREATION_RULES.filter((r) => r.roles.includes(role)).map((r) => r.type);
  return OTHER_TYPE_CREATION.roles.includes(role) ? [...listed, "any other type"] : listed;
}

/** Whether `role` may create a `type` item under a parent of `parentType` (null: no parent). */
export function decideCreate(input: { role: AdoRole; type: string; parentType: string | null }): Decision {
  const { role, type, parentType } = input;
  const rule = creationRule(type);
  const ruleName = `create ${rule?.type ?? "other types"}`;
  const roles = rolesThatMayCreate(type);
  if (!roles.includes(role)) {
    const mine = typesRoleMayCreate(role);
    return {
      ok: false,
      rule: ruleName,
      reason:
        `Workflow rule "${ruleName}": only the ${roleList(roles)} may create ${rule?.type ?? type} work items` +
        (rule?.note ? ` (${rule.note})` : "") +
        `. Your role (${role}) ${mine.length ? `may create: ${mine.join(", ")}` : "may not create work items"}.`,
    };
  }
  if (!rule) {
    return parentType === null
      ? { ok: false, rule: ruleName, reason: `Workflow rule "${ruleName}": ${article(type)} needs a parent; only Epic and Bug have none. Pass parentId.` }
      : { ok: true, rule: ruleName };
  }
  if (rule.parentTypes === null) {
    return parentType === null
      ? { ok: true, rule: ruleName }
      : { ok: false, rule: ruleName, reason: `Workflow rule "${ruleName}": ${article(rule.type)} has no parent. Leave parentId out.` };
  }
  if (parentType === null) {
    return { ok: false, rule: ruleName, reason: `Workflow rule "${ruleName}": ${article(rule.type)} needs ${article(joinOr(rule.parentTypes))} parent. Pass parentId.` };
  }
  if (!includes(rule.parentTypes, parentType)) {
    return {
      ok: false,
      rule: ruleName,
      reason: `Workflow rule "${ruleName}": ${article(rule.type)} goes under ${article(joinOr(rule.parentTypes))}, not under ${article(parentType)}.`,
    };
  }
  return { ok: true, rule: ruleName };
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function typeIsListed(type: string): boolean {
  return STATE_RULES.some((r) => includes(r.types, type));
}

function ruleName(r: { types: readonly string[]; states: readonly string[]; from?: readonly string[] }): string {
  return `${r.types.join(", ")}: ${r.from ? `from ${r.from.join(", ")} to ` : ""}${r.states.join(", ")}`;
}

/**
 * Who may set `state` on a `type` item, and the name of the rule that says so.
 * With `from`, rules for a move from that state count too; from a final state
 * only those do.
 */
export function stateSetters(type: string, state: string, from?: string): { rule: string; setBy: readonly Setter[]; note?: string } {
  if (same(state, INITIAL_STATE)) return { rule: `${type}: ${INITIAL_STATE}`, setBy: [], note: "every item starts in New; the tool never sets it" };
  const fromFinal = from !== undefined && includes(FINAL_STATES, from);
  const rules = STATE_RULES.filter(
    (r) =>
      includes(r.types, type) &&
      includes(r.states, state) &&
      (r.from ? from !== undefined && includes(r.from, from) : !fromFinal),
  );
  if (rules.length) {
    const setBy = [...new Set(rules.flatMap((r) => [...r.setBy]))];
    const note = rules.map((r) => r.note).filter(Boolean).join("; ");
    return { rule: rules.map(ruleName).join(" + "), setBy, ...(note ? { note } : {}) };
  }
  if (typeIsListed(type)) return { rule: `${type}: ${state}`, setBy: [], note: "not in the agents' states for this type" };
  return { rule: "other types: any state", setBy: OTHER_TYPE_STATES.setBy };
}

export function describeSetters(setBy: readonly Setter[]): string {
  if (setBy.length === 0) return "no agent; Josh sets it in ADO";
  const names = setBy.map((s) =>
    s === "assignee"
      ? "the item's assignee (the agent its linked task is assigned to)"
      : s === "owner-of-parent"
        ? "the owner of the item's parent (the agent the parent's linked task is assigned to)"
        : article(s),
  );
  return joinOr(names);
}

export interface StateChangeInput {
  role: AdoRole;
  /** The caller is the agent the work item's linked task is assigned to. */
  isAssignee: boolean;
  /** The caller is the agent the linked task of the work item's ADO parent is assigned to. */
  isParentOwner?: boolean;
  type: string;
  from: string;
  to: string;
}

/** Whether the caller may move the item from `from` to `to`. `to` must already be a valid state of the type. */
export function decideStateChange(input: StateChangeInput): Decision {
  const { role, isAssignee, type, from, to } = input;
  const who = stateSetters(type, to, from);
  const denied = (reason: string): Decision => ({ ok: false, rule: who.rule, reason });
  if (role === "readonly") {
    return denied(`Workflow rule "${who.rule}": your role (readonly) may not change states, even on an item assigned to you.`);
  }
  const leavesFinalByRule = STATE_RULES.some((r) => r.from && includes(r.types, type) && includes(r.states, to) && includes(r.from, from));
  if (includes(FINAL_STATES, from) && !leavesFinalByRule) {
    return {
      ok: false,
      rule: "final states",
      reason: `Workflow rule "final states": ${FINAL_STATES.join(" and ")} are final for agents. No agent may move ${article(type)} out of ${from}; Josh does that in ADO.`,
    };
  }
  const isParentOwner = !!input.isParentOwner;
  const allowed = who.setBy.some((s) => (s === "assignee" ? isAssignee : s === "owner-of-parent" ? isParentOwner : s === role));
  if (!allowed) {
    const facts = [
      ...(who.setBy.includes("assignee") ? [isAssignee ? "the assignee" : "not the assignee"] : []),
      ...(who.setBy.includes("owner-of-parent") ? [isParentOwner ? "the owner of its parent" : "not the owner of its parent"] : []),
    ];
    const why = who.setBy.length === 0 ? "" : ` You are ${role}${facts.length ? ` and ${facts.join(" and ")}` : ""}.`;
    return denied(`Workflow rule "${who.rule}": ${to} on ${article(type)} may be set by ${describeSetters(who.setBy)}.${why}`);
  }
  return { ok: true, rule: who.rule };
}

// ---------------------------------------------------------------------------
// Assigning
// ---------------------------------------------------------------------------

export interface AssignmentInput {
  role: AdoRole;
  callerAgentId: string;
  targetAgentId: string;
  /** The work item's type and ADO tags (for what a role may claim). */
  item: { type: string; tags?: unknown };
  /** The linked task's assignee; null when the work item has no linked task. */
  current: { agentId: string | null; userId: string | null } | null;
  /** The caller holds the linked task only because it claimed it (not because someone assigned it). */
  heldByClaim?: boolean;
  /** The agent assigned to the linked task of the work item's ADO parent (live parent), if any. Needed only when `assignmentNeedsParent`. */
  parentAssigneeAgentId?: string | null;
}

export function isUnassigned(current: AssignmentInput["current"]): boolean {
  return !current || (!current.agentId && !current.userId);
}

/** Whether `role` may claim a work item of this type for itself. */
export function mayClaim(role: AdoRole, item: AssignmentInput["item"]): boolean {
  if (ASSIGN_ANY_ROLES.includes(role)) return true;
  const types = (CLAIM_TYPES as Partial<Record<AdoRole, readonly string[]>>)[role] ?? [];
  return types.some((t) => same(t, item.type));
}

export function claimableTypes(role: AdoRole): string[] {
  return [...((CLAIM_TYPES as Partial<Record<AdoRole, readonly string[]>>)[role] ?? [])];
}

/** True when the decision depends on the parent's linked task (so the caller should look it up). */
export function assignmentNeedsParent(input: Omit<AssignmentInput, "parentAssigneeAgentId">): boolean {
  if (ASSIGN_NONE_ROLES.includes(input.role) || ASSIGN_ANY_ROLES.includes(input.role)) return false;
  if (input.current?.userId) return false;
  if (input.current?.agentId === input.callerAgentId) return !!input.heldByClaim && input.targetAgentId !== input.callerAgentId;
  return isUnassigned(input.current);
}

export function decideAssignment(input: AssignmentInput): Decision<AssignmentRuleId> {
  const { role, callerAgentId, targetAgentId, current } = input;
  const ownParent = !!input.parentAssigneeAgentId && input.parentAssigneeAgentId === callerAgentId;
  if (ASSIGN_NONE_ROLES.includes(role)) {
    return { ok: false, rule: "readonly", reason: `Workflow rule "readonly": your role (${role}) may not assign work items.` };
  }
  if (current?.userId) {
    return {
      ok: false,
      rule: "person",
      reason: `Workflow rule "person": a person holds this work item's linked task, so no agent may take it over. Ask that person or the board.`,
    };
  }
  if (ASSIGN_ANY_ROLES.includes(role)) return { ok: true, rule: "assign-any" };
  if (current?.agentId === callerAgentId) {
    if (!input.heldByClaim || targetAgentId === callerAgentId) return { ok: true, rule: "hand-off" };
    if (ownParent) return { ok: true, rule: "claimed-hand-off" };
    return {
      ok: false,
      rule: "claimed-hand-off",
      reason:
        `Workflow rule "claimed-hand-off": you hold this work item only because you claimed it, so you may hand it on only when its ADO parent's linked task is assigned to you, ` +
        `and it is not. A director or planner may reassign it.`,
    };
  }
  if (isUnassigned(current)) {
    if (ownParent) return { ok: true, rule: "under-own-parent" };
    if (input.parentAssigneeAgentId && targetAgentId === input.parentAssigneeAgentId) return { ok: true, rule: "to-parent-owner" };
    if (targetAgentId === callerAgentId) {
      if (mayClaim(role, input.item)) return { ok: true, rule: "claim" };
      const types = claimableTypes(role);
      return {
        ok: false,
        rule: "claim",
        reason:
          `Workflow rule "claim": as ${role} you may claim only ${types.length ? types.join(", ") : "nothing"}; this is ${article(input.item.type)}. ` +
          "A director or planner may assign it to you.",
      };
    }
    return {
      ok: false,
      rule: "under-own-parent",
      reason:
        `Workflow rule "under-own-parent": as ${role} you may assign an unassigned work item to another agent only when its ADO parent's linked task is assigned to you, ` +
        `or to the agent its ADO parent's linked task is assigned to. Neither holds. You may claim it for yourself if your role works on it; a director or planner may assign it.`,
    };
  }
  return {
    ok: false,
    rule: "hand-off",
    reason:
      `Workflow rule "hand-off": the work item's linked task is assigned to someone else, so as ${role} you may not reassign it. ` +
      `Only the agent it is assigned to, a director or a planner may.`,
  };
}

// ---------------------------------------------------------------------------
// The rules as agents read them (ado_get_workflow)
// ---------------------------------------------------------------------------

export function workflowData() {
  return {
    roles: ROLES.map((role) => ({ role, ...ROLE_DESCRIPTIONS[role] })),
    assignment: ASSIGNMENT_RULES.map((r) => ({ ...r })),
    creation: [
      ...CREATION_RULES.map((r) => ({ type: r.type, roles: [...r.roles], parentTypes: r.parentTypes ? [...r.parentTypes] : null, ...(r.note ? { note: r.note } : {}) })),
      { type: "*", roles: [...OTHER_TYPE_CREATION.roles], parentTypes: "any" as const, note: OTHER_TYPE_CREATION.note },
    ],
    states: [
      ...STATE_RULES.map((r) => ({
        types: [...r.types],
        states: [...r.states],
        setBy: [...r.setBy],
        ...(r.from ? { from: [...r.from] } : {}),
        ...(r.note ? { note: r.note } : {}),
      })),
      { types: ["*"], states: ["*"], setBy: [...OTHER_TYPE_STATES.setBy] },
    ],
    claimTypes: Object.fromEntries(Object.entries(CLAIM_TYPES).map(([role, types]) => [role, [...types]])),
    initialState: INITIAL_STATE,
    finalStates: [...FINAL_STATES],
    reviewRoundLimit: REVIEW_ROUND_LIMIT,
  };
}

const who = (setBy: readonly Setter[]) => (setBy.length ? setBy.join(", ") : "Josh (no agent)");

/** Compact text of workflowData(), for agents. */
export function workflowText(): string {
  const d = workflowData();
  const lines = [
    "ADO workflow rules (enforced by the ADO tools).",
    "",
    "Roles:",
    ...d.roles.map((r) => `- ${r.role}: ${r.who}. ${r.notes}.`),
    "",
    "Assigning a work item means assigning its linked Paperclip task (never ADO's Assigned To):",
    ...d.assignment.map((r) => `- ${r.text}.`),
    "What each role may claim:",
    ...Object.entries(d.claimTypes).map(([role, types]) => `- ${role}: ${types.join(", ")}.`),
    "A new linked task goes under the ADO parent's linked task and its project, if the parent has one; else in your current task's project.",
    "",
    "Creating work items (type: who may create; parent):",
    ...d.creation.map((r) => {
      const parent = r.parentTypes === null ? "no parent" : r.parentTypes === "any" ? "any parent" : `under ${r.parentTypes.join(" or ")}`;
      return `- ${r.type === "*" ? "any other type" : r.type}: ${r.roles.join(", ")}; ${parent}${r.note ? ` (${r.note})` : ""}.`;
    }),
    "",
    `States (type: states: who may set them). "assignee" is the agent the item's linked task is assigned to. Every item starts in ${d.initialState}; ${d.initialState} is never set by the tools.`,
    ...d.states.map(
      (r) =>
        `- ${r.types[0] === "*" ? "any other type" : r.types.join(", ")}: ${"from" in r && r.from ? `from ${r.from.join(", ")} to ` : ""}${r.states[0] === "*" ? "any state" : r.states.join(", ")}: ${who(r.setBy)}${r.note ? ` (${r.note})` : ""}.`,
    ),
    "For a listed type, a state not listed is set by Josh only.",
    `${d.finalStates.join(" and ")} are final for agents: no agent moves an item out of them (not even to Blocked), except where a rule above says "from Completed"; otherwise Josh does, in ADO.`,
    `"owner-of-parent" is the agent the linked task of the item's ADO parent is assigned to.`,
    "A listed state may be set from any state unless its rule says \"from\"; the order of moves is yours to follow.",
    "",
    "Who owns what: only an item's owner moves it. Others signal through their own items, and every state change of a child wakes the owner of its parent.",
    "- Feature, Epic, Documentation: the plugin sets them Completed once they are In Progress and every item under them is Completed or Removed. Their owners are woken by a child only when it is Blocked.",
    `- User Story or Bug (builder): In Progress → open one pull request → set each ${REVIEW_TYPE} ${READY_FOR_REVIEW_STATE} and the item In Review → when every ${REVIEW_TYPE} is ${APPROVED_STATE}, ${READY_TO_MERGE_STATE} (Josh merges) → after the merge, set each ${QA_TEST_TYPE} ${READY_FOR_TEST_STATE} and the item ${IN_TESTING_STATE} → when every ${QA_TEST_TYPE} is ${PASSED_STATE} and no ${DEFECT_TYPE} is open, ${COMPLETED_STATE}.`,
    `- ${REVIEW_TYPE} (reviewer): ${READY_FOR_REVIEW_STATE} wakes you → In Review → ${APPROVED_STATE}, or ${CHANGES_REQUESTED_STATE} with comments on the pull request. The builder fixes and sets it ${READY_FOR_REVIEW_STATE} again. The ${d.reviewRoundLimit}rd ${CHANGES_REQUESTED_STATE} since the last ${APPROVED_STATE} is refused: set ${BLOCKED_STATE} with a summary for Josh.`,
    `- ${QA_TEST_TYPE} (QA): ${READY_FOR_TEST_STATE} wakes you → Testing → ${PASSED_STATE}, or Failed with a ${DEFECT_TYPE} under the item for each problem, assigned to the item's owner.`,
    `- ${DEFECT_TYPE} (builder): In Progress → a new pull request → the item goes back through In Review and ${READY_TO_MERGE_STATE} → after the merge, ${READY_FOR_RETEST_STATE} (wakes QA) → QA sets ${COMPLETED_STATE}, or In Progress if it still fails.`,
    `- ${DOCUMENT_TYPE} (author): In Progress → a pull request with the markdown in the documents repository → In Review (Josh's turn) → Josh sets ${CHANGES_REQUESTED_STATE} (fix, then In Progress and In Review again) or merges the pull request (set ${COMPLETED_STATE}).`,
    `- ${REVIEW_TYPE}s and ${QA_TEST_TYPE}s close when their item is set ${COMPLETED_STATE}; until then they stay open, so they can be handed over again.`,
    "",
    "Your linked Paperclip task follows its work item: it closes by itself when the work item is Completed or Removed, so never mark it done; wait in review instead.",
    "You are woken, with a comment on your task saying what changed, whenever anyone else changes your work item (state, comments, description, acceptance criteria), a child of it changes state, it is handed to you (Ready For Review, Ready For Test, Ready For Retest), or someone comments on or completes its pull request.",
  ];
  return lines.join("\n");
}
