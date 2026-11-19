/**
 * The ADO workflow rules for agents, as data: roles, who may assign, who may
 * create which work item type under which parent, and who may set which state. This is the single enforcement copy of
 * doc/plans/2026-11-17-agent-workflow.md; the agent tools, the
 * ado_get_workflow output and the tests all read these tables.
 */

/** Every ADO role, most rights first. The `agentRoles` setting picks one per agent. */
export const ROLES = ["director", "planner", "architect", "author", "builder", "reviewer", "qa", "readonly"] as const;
export type AdoRole = (typeof ROLES)[number];

export const DEFAULT_ROLE: AdoRole = "readonly";

export const ROLE_DESCRIPTIONS: Record<AdoRole, { who: string; notes: string }> = {
  director: { who: "Tiamat", notes: "Intake, Epic and Documentation, assigning approved work, Feature and Epic roll-up" },
  planner: { who: "Orochi", notes: "The plan and the work item tree: Features, Stories, Tasks, Reviews and QA Tests" },
  architect: { who: "Ryujin, Fafnir", notes: "Technical notes, Ready For Approval, architecture Documents and Reviews" },
  author: { who: "Zhulong, Fucanglong, Kukulkan", notes: "Their own Documents (product analysis, technical design, designs), each as a pull request" },
  builder: { who: "Engineers", notes: "Their own Stories, Bugs, Documents, Tasks and Defects" },
  reviewer: { who: "Ladon and the other gate agents", notes: "Their own Review items" },
  qa: { who: "QA testers", notes: "Their own QA Test items, and the Defects they find" },
  readonly: { who: "Anyone not listed", notes: "Read only" },
};

/**
 * Who may set a state: a role; the item's assignee (the agent its linked task
 * is assigned to); or the owner of the item's parent (the agent assigned to the
 * linked task of the item's ADO parent), which is how a builder hands its
 * Reviews and QA Tests over.
 */
export type Setter = AdoRole | "assignee" | "owner-of-parent";

/** Work item type names as the ADO process spells them. Matching is case-insensitive. */
export interface CreationRule {
  type: string;
  roles: readonly AdoRole[];
  /** Parent types allowed; null means the type has no parent. */
  parentTypes: readonly string[] | null;
  note?: string;
}

/** The work item a reviewer works on: one under each User Story or Bug per review gate. */
export const REVIEW_TYPE = "Review";
/** The work item a QA tester works on: one or more under each User Story or Bug. */
export const QA_TEST_TYPE = "QA Test";
/** A problem QA found in work that is not yet released: under the User Story or Bug. */
export const DEFECT_TYPE = "Defect";
/** The Document type: written as markdown in a pull request that Josh reviews and merges. */
export const DOCUMENT_TYPE = "Document";

/**
 * The code items: one pull request each (plus one per Defect fix).
 * New → In Progress → In Review (its Reviews are Ready For Review) →
 * Ready To Merge (every Review Approved; Josh merges) → In Testing (its QA
 * Tests are Ready For Test) → Completed (every QA Test Passed, no open Defect).
 */
export const STORY_TYPES = ["User Story", "Bug"] as const;
/** The children an item's owner hands over and waits for. */
export const HANDOFF_TYPES = [REVIEW_TYPE, QA_TEST_TYPE] as const;

export const CREATION_RULES: readonly CreationRule[] = [
  { type: "Epic", roles: ["director", "planner"], parentTypes: null },
  { type: "Documentation", roles: ["director", "planner"], parentTypes: ["Epic"], note: "the planner too, for a team with no director" },
  { type: DOCUMENT_TYPE, roles: ["director", "planner"], parentTypes: ["Documentation"] },
  { type: "Feature", roles: ["planner"], parentTypes: ["Epic"] },
  { type: "User Story", roles: ["planner"], parentTypes: ["Feature"] },
  { type: "Bug", roles: ["planner"], parentTypes: null, note: "Josh enters Bugs in ADO" },
  { type: "Task", roles: ["planner", "builder"], parentTypes: [...STORY_TYPES] },
  { type: REVIEW_TYPE, roles: ["planner"], parentTypes: [...STORY_TYPES], note: "created with the breakdown, one per review gate" },
  { type: QA_TEST_TYPE, roles: ["planner"], parentTypes: [...STORY_TYPES], note: "created with the breakdown" },
  { type: DEFECT_TYPE, roles: ["qa", "planner"], parentTypes: [...STORY_TYPES], note: "QA creates one per problem found, and assigns it to the item's owner" },
];

/** Any type not in CREATION_RULES: planner only, under any parent ADO allows. */
export const OTHER_TYPE_CREATION = { roles: ["planner"] as readonly AdoRole[], note: "under any parent ADO allows" };

export interface StateRule {
  types: readonly string[];
  states: readonly string[];
  /** Empty: no agent may set it (Josh does, in ADO). */
  setBy: readonly Setter[];
  /**
   * Only for a move from one of these states. Without it the rule applies
   * from any state except a final one; with it, it may also name a final
   * state the rule lets an agent leave.
   */
  from?: readonly string[];
  note?: string;
}

/** Rounds of changes a reviewer may ask for on one Review since it last approved; the request that would reach this many sets Blocked for Josh instead. */
export const REVIEW_ROUND_LIMIT = 3;
const REVIEW_ROUND_LIMIT_TEXT = `${REVIEW_ROUND_LIMIT}rd`;

export const CHANGES_REQUESTED_STATE = "Changes Requested";
export const BLOCKED_STATE = "Blocked";
export const READY_TO_MERGE_STATE = "Ready To Merge";
export const IN_TESTING_STATE = "In Testing";
export const READY_FOR_REVIEW_STATE = "Ready For Review";
export const APPROVED_STATE = "Approved";
export const READY_FOR_TEST_STATE = "Ready For Test";
export const PASSED_STATE = "Passed";
export const READY_FOR_RETEST_STATE = "Ready For Retest";
export const COMPLETED_STATE = "Completed";

/** States whose name tells the item's assignee it is their turn: setting one wakes them. */
export const HANDOFF_STATES: readonly string[] = [READY_FOR_REVIEW_STATE, READY_FOR_TEST_STATE, READY_FOR_RETEST_STATE];

export const STATE_RULES: readonly StateRule[] = [
  { types: ["Epic"], states: ["Documenting"], setBy: ["director", "planner"], note: "the Documentation is being written" },
  { types: ["Epic"], states: ["Planning"], setBy: ["director", "planner"], note: "the planner writes the plan" },
  { types: ["Epic"], states: ["Plan Review"], setBy: ["planner"], note: "the plan is written and waits for Josh" },
  { types: ["Epic"], states: ["In Progress"], setBy: [], note: "Josh approves the plan; this wakes the planner, who builds the work item tree" },
  { types: ["Epic"], states: [COMPLETED_STATE], setBy: ["director", "planner"], note: "the plugin sets it when every item under it is Completed or Removed" },
  { types: ["Epic"], states: [BLOCKED_STATE], setBy: ["director", "planner"] },
  { types: ["Epic"], states: ["Removed"], setBy: [] },
  {
    types: ["Documentation"],
    states: ["In Progress", BLOCKED_STATE, COMPLETED_STATE],
    setBy: ["director", "planner"],
    note: "the plugin sets Completed when every Document under it is Completed or Removed",
  },
  {
    types: [DOCUMENT_TYPE],
    states: ["In Progress", "In Review", BLOCKED_STATE, COMPLETED_STATE],
    setBy: ["assignee"],
    note: "In Review when its pull request is open for Josh; Completed when Josh merges it",
  },
  { types: [DOCUMENT_TYPE], states: [CHANGES_REQUESTED_STATE], setBy: [], note: "Josh asks for changes; the author sets In Progress and fixes" },
  { types: [DOCUMENT_TYPE], states: ["Removed"], setBy: ["director", "planner"] },
  { types: ["Feature"], states: ["Refining", "Technical Notes"], setBy: ["planner"], note: "Technical Notes: hand the Feature to the architect" },
  { types: ["Feature"], states: ["Ready For Approval"], setBy: ["architect", "planner"], note: "the breakdown is done and waits for Josh" },
  { types: ["Feature"], states: ["Ready For Work"], setBy: [], note: "Josh approves the breakdown; this wakes the Feature's owner, who assigns the work" },
  { types: ["Feature"], states: ["In Progress", COMPLETED_STATE], setBy: ["director", "planner"], note: "the plugin sets Completed when every item under it is Completed or Removed" },
  { types: ["Feature"], states: [BLOCKED_STATE], setBy: ["director", "planner", "architect"] },
  { types: ["Feature"], states: ["Removed"], setBy: [] },
  {
    types: STORY_TYPES,
    states: ["In Progress", "In Review", READY_TO_MERGE_STATE, IN_TESTING_STATE, COMPLETED_STATE, BLOCKED_STATE],
    setBy: ["assignee"],
    note:
      `${READY_TO_MERGE_STATE} only when every ${REVIEW_TYPE} under it is ${APPROVED_STATE}; ` +
      `${COMPLETED_STATE} only when every ${QA_TEST_TYPE} under it is ${PASSED_STATE} and no ${DEFECT_TYPE} is open, and it closes those ${REVIEW_TYPE}s and ${QA_TEST_TYPE}s`,
  },
  { types: STORY_TYPES, states: ["Removed"], setBy: ["planner"] },
  { types: ["Task"], states: ["In Progress", BLOCKED_STATE, COMPLETED_STATE], setBy: ["assignee"] },
  {
    types: [REVIEW_TYPE],
    states: [READY_FOR_REVIEW_STATE],
    setBy: ["owner-of-parent"],
    note: "the builder hands the pull request to the reviewer (again after fixes or a Defect fix); this wakes the reviewer",
  },
  {
    types: [REVIEW_TYPE],
    states: ["In Review", CHANGES_REQUESTED_STATE, APPROVED_STATE, BLOCKED_STATE],
    setBy: ["assignee"],
    note: `${CHANGES_REQUESTED_STATE} when the review asks for changes (the ${REVIEW_ROUND_LIMIT_TEXT} time since the last approval is ${BLOCKED_STATE} instead); ${APPROVED_STATE} when it approves. Both wake the builder`,
  },
  {
    types: [QA_TEST_TYPE],
    states: [READY_FOR_TEST_STATE],
    setBy: ["owner-of-parent"],
    note: "the builder hands the merged work to QA (again after a Defect fix); this wakes the tester",
  },
  {
    types: [QA_TEST_TYPE],
    states: ["Testing", "Failed", PASSED_STATE, BLOCKED_STATE],
    setBy: ["assignee"],
    note: `Failed with a ${DEFECT_TYPE} for each problem; ${PASSED_STATE} when it passes. Both wake the builder`,
  },
  { types: [...HANDOFF_TYPES], states: [COMPLETED_STATE], setBy: [], note: `closed by the tools when the item above it is set ${COMPLETED_STATE}` },
  {
    types: [DEFECT_TYPE],
    states: ["In Progress", READY_FOR_RETEST_STATE, BLOCKED_STATE],
    setBy: ["assignee"],
    note: `${READY_FOR_RETEST_STATE} once the fix is merged; this wakes QA`,
  },
  { types: [DEFECT_TYPE], states: [COMPLETED_STATE, "In Progress"], setBy: ["qa"], note: "QA closes it after the retest passes, or sends it back to In Progress" },
  { types: [...HANDOFF_TYPES, DEFECT_TYPE, "Task"], states: ["Removed"], setBy: ["planner"] },
];

/** Any type not in STATE_RULES: any state, by the assignee or a director. */
export const OTHER_TYPE_STATES = { setBy: ["assignee", "director"] as readonly Setter[] };

/** Every type starts in this state; the tool never sets it. */
export const INITIAL_STATE = "New";

/** Final for agents: no agent moves an item out of these (not even to Blocked); Josh does, in ADO. */
export const FINAL_STATES: readonly string[] = ["Completed", "Removed"];

/**
 * Items the plugin completes itself (A4 roll-ups): once one is in an active
 * state and every work item under it is Completed or Removed (at least one
 * Completed), the plugin sets it Completed. Their owners are not woken for
 * their children's ordinary moves, only when a child is Blocked.
 */
export const ROLLUP_RULES: ReadonlyArray<{ type: string; activeStates: readonly string[] }> = [
  { type: "Feature", activeStates: ["In Progress"] },
  { type: "Epic", activeStates: ["In Progress"] },
  { type: "Documentation", activeStates: ["In Progress"] },
];

/**
 * The states that wait for Josh (D4): the toolbar's "Needs you" list and its
 * Windows notifications. First match wins; "*" is any type.
 */
export const JOSH_WAITS: ReadonlyArray<{ types: readonly string[]; state: string; action: string }> = [
  { types: ["Epic"], state: "Plan Review", action: "Approve the plan: set the Epic In Progress" },
  { types: ["Feature"], state: "Ready For Approval", action: "Approve the breakdown: set the Feature Ready For Work" },
  { types: ["User Story", "Bug"], state: "Ready To Merge", action: "Review and merge the pull request" },
  { types: ["Document"], state: "In Review", action: "Review the document's pull request" },
  { types: ["*"], state: "Blocked", action: "Answer the question" },
];

/** What Josh is asked to do about an item in this state, or null if it does not wait for him. */
export function joshWaitFor(type: string, state: string): string | null {
  const t = type.trim().toLowerCase();
  const st = state.trim().toLowerCase();
  const rule = JOSH_WAITS.find((r) => r.state.toLowerCase() === st && (r.types.includes("*") || r.types.some((x) => x.toLowerCase() === t)));
  return rule?.action ?? null;
}

/** The signature on history entries the plugin writes itself (roll-ups). */
export const PLUGIN_SIGNATURE = "ADO plugin";


/** Who may assign (ado_update_assignment, and assignTo on ado_create_work_item). */
export const ASSIGN_ANY_ROLES: readonly AdoRole[] = ["director", "planner"];
export const ASSIGN_NONE_ROLES: readonly AdoRole[] = ["readonly"];

/** What each role may claim for itself (director and planner assign anything; readonly nothing). */
export const CLAIM_TYPES: Record<"builder" | "reviewer" | "architect" | "author" | "qa", readonly string[]> = {
  builder: ["User Story", "Bug", "Task", DEFECT_TYPE, DOCUMENT_TYPE],
  reviewer: [REVIEW_TYPE],
  architect: [DOCUMENT_TYPE, "Task", REVIEW_TYPE],
  author: [DOCUMENT_TYPE],
  qa: [QA_TEST_TYPE],
};

const claimText = (Object.entries(CLAIM_TYPES) as Array<[string, readonly string[]]>)
  .map(([role, types]) => `${role} ${types.join(", ")}`)
  .join("; ");

export const ASSIGNMENT_RULES = [
  { id: "assign-any", text: "director and planner may assign any work item to any agent" },
  { id: "person", text: "no agent may take over a work item whose linked task is assigned to a person" },
  {
    id: "hand-off",
    text: "other roles (not readonly) may hand off a work item whose linked task was assigned to them, to any agent",
  },
  {
    id: "claimed-hand-off",
    text: "a work item they hold only because they claimed it may be handed off only when its ADO parent's linked task is assigned to them",
  },
  {
    id: "under-own-parent",
    text: "other roles (not readonly) may assign an unassigned work item whose ADO parent's linked task is assigned to them, to any agent",
  },
  {
    id: "to-parent-owner",
    text: "other roles (not readonly) may assign an unassigned work item to the agent its ADO parent's linked task is assigned to (QA assigns a Defect to the Story's owner)",
  },
  {
    id: "claim",
    text: `other roles (not readonly) may claim an unassigned work item for themselves, of the types their role works on: ${claimText}`,
  },
  { id: "readonly", text: "readonly may not assign" },
  { id: "target", text: "the target agent must belong to the company and not be terminated or awaiting approval" },
] as const;
export type AssignmentRuleId = (typeof ASSIGNMENT_RULES)[number]["id"];
