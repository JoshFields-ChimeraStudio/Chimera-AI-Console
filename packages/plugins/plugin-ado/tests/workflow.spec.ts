/**
 * The agent workflow (doc/plans/2026-11-17-agent-workflow.md): the rule tables
 * and decisions in src/workflow/, and the tools that enforce them, run through
 * the whole worker (assignment shares the Backlog view's path).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, ToolResult } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { createAdoPlugin } from "../src/worker.js";
import { ADO_LINK_ORIGIN_KIND } from "../src/links/index.js";
import { TOOL_NAMES } from "../src/tools/definitions.js";
import { ROLE_POLICIES } from "../src/tools/roles.js";
import {
  ASSIGNMENT_RULES,
  CREATION_RULES,
  OTHER_TYPE_STATES,
  CLAIM_TYPES,
  FINAL_STATES,
  ROLES,
  STATE_RULES,
  assignmentNeedsParent,
  mayClaim,
  decideAssignment,
  decideCreate,
  decideStateChange,
  stateSetters,
  typeHasParent,
  workflowData,
  workflowText,
  type AdoRole,
} from "../src/workflow/index.js";
import { fakeLinkRepository, fakeWorkItemCacheRepository } from "./fakes.js";

const STORY_STATES = ["New", "In Progress", "Blocked", "In Review", "Ready To Merge", "In Testing", "Completed", "Removed"];
const DOCUMENT_STATES = ["New", "In Progress", "In Review", "Blocked", "Changes Requested", "Completed", "Removed"];

describe("workflow rules", () => {
  describe("state matrix (role x type x state x assignee), from the state table", () => {
    const cases = STATE_RULES.flatMap((rule) =>
      rule.types.flatMap((type) =>
        rule.states.flatMap((state) =>
          ROLES.flatMap((role) =>
            [true, false].flatMap((isAssignee) => [true, false].map((isParentOwner) => ({ rule, type, state, role, isAssignee, isParentOwner }))),
          ),
        ),
      ),
    );

    it.each(cases)("$type $state by $role (assignee: $isAssignee, parent owner: $isParentOwner)", ({ rule, type, state, role, isAssignee, isParentOwner }) => {
      // A rule with "from" is tested from its first from-state; every rule for that move counts.
      const from = rule.from?.[0] ?? "New";
      const fromFinal = ["Completed", "Removed"].includes(from);
      const setBy = STATE_RULES.filter(
        (r) => r.types.includes(type) && r.states.includes(state) && (r.from ? r.from.includes(from) : !fromFinal),
      ).flatMap((r) => r.setBy);
      const expected =
        role !== "readonly" && setBy.some((s) => (s === "assignee" ? isAssignee : s === "owner-of-parent" ? isParentOwner : s === role));
      const d = decideStateChange({ role, isAssignee, isParentOwner, type, from, to: state });
      expect(d.ok).toBe(expected);
      if (!d.ok) expect(d.reason).toMatch(/^Workflow rule "/);
    });

    it("covers every role and the types of the spec", () => {
      expect(new Set(STATE_RULES.flatMap((r) => r.types))).toEqual(
        new Set(["Epic", "Documentation", "Document", "Feature", "User Story", "Bug", "Task", "Defect", "Review", "QA Test"]),
      );
      expect(cases.length).toBeGreaterThan(300);
    });

    it("other types: any state, by the assignee or a director", () => {
      for (const role of ROLES) {
        for (const isAssignee of [true, false]) {
          const expected = role !== "readonly" && OTHER_TYPE_STATES.setBy.some((s) => (s === "assignee" ? isAssignee : s === role));
          expect(decideStateChange({ role, isAssignee, type: "Test Case", from: "Design", to: "Ready" }).ok).toBe(expected);
        }
      }
    });

    it("New is never set; a state not listed for a listed type is Josh's", () => {
      for (const role of ROLES) {
        expect(decideStateChange({ role, isAssignee: true, type: "Task", from: "In Progress", to: "New" }).ok).toBe(false);
        expect(decideStateChange({ role, isAssignee: true, type: "Feature", from: "New", to: "Active" }).ok).toBe(false);
        expect(decideStateChange({ role, isAssignee: true, type: "Test Case", from: "Design", to: "New" }).ok).toBe(false);
      }
      expect(stateSetters("Epic", "in progress")).toMatchObject({ rule: "Epic: In Progress", setBy: [] });
    });

    it("matches types and states case-insensitively", () => {
      expect(decideStateChange({ role: "architect", isAssignee: false, type: "feature", from: "Technical Notes", to: "ready for approval" }).ok).toBe(true);
    });
  });

  describe("state denial messages", () => {
    it("name the rule and who may set the state", () => {
      expect(decideStateChange({ role: "planner", isAssignee: true, type: "Feature", from: "Ready For Approval", to: "Ready For Work" })).toEqual({
        ok: false,
        rule: "Feature: Ready For Work",
        reason: 'Workflow rule "Feature: Ready For Work": Ready For Work on a Feature may be set by no agent; Josh sets it in ADO.',
      });
      expect(decideStateChange({ role: "builder", isAssignee: true, type: "Feature", from: "Refining", to: "Ready For Approval" })).toMatchObject({
        reason: 'Workflow rule "Feature: Ready For Approval": Ready For Approval on a Feature may be set by an architect or a planner. You are builder.',
      });
      expect(decideStateChange({ role: "planner", isAssignee: false, type: "Epic", from: "Plan Review", to: "In Progress" })).toMatchObject({
        reason: 'Workflow rule "Epic: In Progress": In Progress on an Epic may be set by no agent; Josh sets it in ADO.',
      });
      expect(decideStateChange({ role: "planner", isAssignee: false, type: "User Story", from: "New", to: "In Progress" })).toMatchObject({
        reason:
          'Workflow rule "User Story, Bug: In Progress, In Review, Ready To Merge, In Testing, Completed, Blocked": In Progress on a User Story may be set by ' +
          "the item's assignee (the agent its linked task is assigned to). You are planner and not the assignee.",
      });
      expect(decideStateChange({ role: "reviewer", isAssignee: true, type: "Review", from: "New", to: "Ready For Review" })).toMatchObject({
        reason:
          'Workflow rule "Review: Ready For Review": Ready For Review on a Review may be set by ' +
          "the owner of the item's parent (the agent the parent's linked task is assigned to). You are reviewer and not the owner of its parent.",
      });
      expect(decideStateChange({ role: "builder", isAssignee: false, type: "Test Case", from: "Design", to: "Ready" })).toMatchObject({
        reason:
          'Workflow rule "other types: any state": Ready on a Test Case may be set by ' +
          "the item's assignee (the agent its linked task is assigned to) or a director. You are builder and not the assignee.",
      });
      expect(decideStateChange({ role: "readonly", isAssignee: true, type: "Task", from: "New", to: "In Progress" })).toMatchObject({
        reason: 'Workflow rule "Task: In Progress, Blocked, Completed": your role (readonly) may not change states, even on an item assigned to you.',
      });
    });
  });

  describe("owners move their own items (literal)", () => {
    it.each(["User Story", "Bug"])("%s: only its builder moves it, through In Testing; no Changes Requested", (type) => {
      const builder = { role: "builder" as const, isAssignee: true, type };
      for (const to of ["In Progress", "In Review", "Ready To Merge", "In Testing", "Completed", "Blocked"]) {
        expect(decideStateChange({ ...builder, from: "New", to }).ok).toBe(true);
        for (const role of ["reviewer", "qa", "director"] as const) {
          expect(decideStateChange({ role, isAssignee: false, isParentOwner: true, type, from: "New", to }).ok).toBe(false);
        }
      }
      expect(decideStateChange({ ...builder, from: "In Review", to: "Changes Requested" }).ok).toBe(false);
    });

    it("Review: the builder hands it over with Ready For Review; the reviewer works and finishes it; nobody closes it by hand", () => {
      const builder = { role: "builder" as const, isAssignee: false, isParentOwner: true, type: "Review" };
      const reviewer = { role: "reviewer" as const, isAssignee: true, type: "Review" };
      expect(decideStateChange({ ...builder, from: "New", to: "Ready For Review" }).ok).toBe(true);
      expect(decideStateChange({ ...builder, from: "Changes Requested", to: "Ready For Review" }).ok).toBe(true);
      expect(decideStateChange({ ...builder, from: "Approved", to: "Ready For Review" }).ok).toBe(true);
      expect(decideStateChange({ ...builder, isParentOwner: false, from: "New", to: "Ready For Review" }).ok).toBe(false);
      for (const to of ["In Review", "Changes Requested", "Approved", "Blocked"]) {
        expect(decideStateChange({ ...reviewer, from: "Ready For Review", to }).ok).toBe(true);
        expect(decideStateChange({ ...builder, from: "Ready For Review", to }).ok).toBe(false);
      }
      expect(decideStateChange({ ...reviewer, from: "Approved", to: "Completed" }).ok).toBe(false);
      expect(decideStateChange({ ...reviewer, from: "New", to: "Ready For Review" }).ok).toBe(false);
    });

    it("QA Test: the builder hands it over with Ready For Test; QA tests, passes or fails it", () => {
      const builder = { role: "builder" as const, isAssignee: false, isParentOwner: true, type: "QA Test" };
      const qa = { role: "qa" as const, isAssignee: true, type: "QA Test" };
      expect(decideStateChange({ ...builder, from: "Failed", to: "Ready For Test" }).ok).toBe(true);
      for (const to of ["Testing", "Failed", "Passed", "Blocked"]) {
        expect(decideStateChange({ ...qa, from: "Ready For Test", to }).ok).toBe(true);
        expect(decideStateChange({ ...builder, from: "Ready For Test", to }).ok).toBe(false);
      }
      expect(decideStateChange({ ...qa, from: "Passed", to: "Completed" }).ok).toBe(false);
    });

    it("Defect: the builder fixes it to Ready For Retest; QA closes it or sends it back", () => {
      const builder = { role: "builder" as const, isAssignee: true, type: "Defect" };
      for (const to of ["In Progress", "Ready For Retest", "Blocked"]) expect(decideStateChange({ ...builder, from: "New", to }).ok).toBe(true);
      expect(decideStateChange({ ...builder, from: "Ready For Retest", to: "Completed" }).ok).toBe(false);
      for (const to of ["Completed", "In Progress"]) {
        expect(decideStateChange({ role: "qa", isAssignee: false, type: "Defect", from: "Ready For Retest", to }).ok).toBe(true);
      }
    });

    it("Document: its author moves it; Josh asks for changes", () => {
      const author = { role: "builder" as const, isAssignee: true, type: "Document" };
      for (const to of ["In Progress", "In Review", "Completed", "Blocked"]) expect(decideStateChange({ ...author, from: "New", to }).ok).toBe(true);
      for (const role of ROLES) {
        expect(decideStateChange({ role, isAssignee: true, type: "Document", from: "In Review", to: "Changes Requested" }).ok).toBe(false);
      }
      expect(decideStateChange({ ...author, from: "Changes Requested", to: "In Progress" }).ok).toBe(true);
      expect(decideStateChange({ ...author, from: "In Review", to: "Ready To Merge" }).ok).toBe(false);
    });

    it("Epic: the director documents, the planner plans and hands it to Josh, Josh approves", () => {
      expect(decideStateChange({ role: "director", isAssignee: true, type: "Epic", from: "New", to: "Documenting" }).ok).toBe(true);
      expect(decideStateChange({ role: "planner", isAssignee: true, type: "Epic", from: "Documenting", to: "Planning" }).ok).toBe(true);
      expect(decideStateChange({ role: "planner", isAssignee: true, type: "Epic", from: "Planning", to: "Plan Review" }).ok).toBe(true);
      expect(decideStateChange({ role: "director", isAssignee: true, type: "Epic", from: "Planning", to: "Plan Review" }).ok).toBe(false);
      for (const role of ROLES) expect(decideStateChange({ role, isAssignee: true, type: "Epic", from: "Plan Review", to: "In Progress" }).ok).toBe(false);
      expect(decideStateChange({ role: "planner", isAssignee: true, type: "Epic", from: "In Progress", to: "Completed" }).ok).toBe(true);
    });

    it("Feature: the planner refines, the architect adds notes, Josh approves, the director or planner runs it", () => {
      expect(decideStateChange({ role: "planner", isAssignee: true, type: "Feature", from: "New", to: "Refining" }).ok).toBe(true);
      expect(decideStateChange({ role: "planner", isAssignee: true, type: "Feature", from: "Refining", to: "Technical Notes" }).ok).toBe(true);
      expect(decideStateChange({ role: "architect", isAssignee: true, type: "Feature", from: "Technical Notes", to: "Refining" }).ok).toBe(false);
      for (const role of ROLES) {
        expect(decideStateChange({ role, isAssignee: true, type: "Feature", from: "Ready For Approval", to: "Ready For Work" }).ok).toBe(false);
      }
      for (const role of ["director", "planner"] as const) {
        expect(decideStateChange({ role, isAssignee: true, type: "Feature", from: "Ready For Work", to: "In Progress" }).ok).toBe(true);
      }
    });

    it("Removed: the planner for Stories, Bugs and their children, the director or planner for Documents", () => {
      expect(decideStateChange({ role: "planner", isAssignee: false, type: "User Story", from: "New", to: "Removed" }).ok).toBe(true);
      expect(decideStateChange({ role: "planner", isAssignee: false, type: "QA Test", from: "New", to: "Removed" }).ok).toBe(true);
      expect(decideStateChange({ role: "planner", isAssignee: false, type: "Document", from: "New", to: "Removed" }).ok).toBe(true);
      expect(decideStateChange({ role: "author", isAssignee: true, type: "Document", from: "New", to: "Removed" }).ok).toBe(false);
      expect(decideStateChange({ role: "director", isAssignee: false, type: "Document", from: "In Review", to: "Removed" }).ok).toBe(true);
    });
  });

  describe("creation table", () => {
    const cases = CREATION_RULES.flatMap((rule) => ROLES.map((role) => ({ rule, role })));

    it.each(cases)("$rule.type by $role", ({ rule, role }) => {
      const allowed = rule.roles.includes(role);
      if (rule.parentTypes === null) {
        expect(decideCreate({ role, type: rule.type, parentType: null }).ok).toBe(allowed);
        expect(decideCreate({ role, type: rule.type, parentType: "Epic" }).ok).toBe(false);
      } else {
        for (const parentType of rule.parentTypes) expect(decideCreate({ role, type: rule.type, parentType }).ok).toBe(allowed);
        expect(decideCreate({ role, type: rule.type, parentType: null }).ok).toBe(false);
        expect(decideCreate({ role, type: rule.type, parentType: "Test Case" }).ok).toBe(false);
      }
    });

    it("only Epic and Bug are parentless", () => {
      expect(CREATION_RULES.filter((r) => !typeHasParent(r.type)).map((r) => r.type)).toEqual(["Epic", "Bug"]);
      expect(typeHasParent("Test Case")).toBe(true);
    });

    it("other types: planner only, under any parent", () => {
      for (const role of ROLES) expect(decideCreate({ role, type: "Test Case", parentType: "User Story" }).ok).toBe(role === "planner");
      expect(decideCreate({ role: "planner", type: "Test Case", parentType: null })).toMatchObject({ ok: false, reason: expect.stringContaining("needs a parent") });
    });

    it("explains what the role may create instead", () => {
      expect(decideCreate({ role: "builder", type: "Epic", parentType: null })).toMatchObject({
        reason: 'Workflow rule "create Epic": only the director or planner roles may create Epic work items. Your role (builder) may create: Task.',
      });
      expect(decideCreate({ role: "reviewer", type: "Task", parentType: "User Story" })).toMatchObject({
        reason: expect.stringContaining("Your role (reviewer) may not create work items."),
      });
      expect(decideCreate({ role: "director", type: "Epic", parentType: "Feature" })).toMatchObject({
        reason: 'Workflow rule "create Epic": an Epic has no parent. Leave parentId out.',
      });
      expect(decideCreate({ role: "builder", type: "Task", parentType: "Feature" })).toMatchObject({
        reason: 'Workflow rule "create Task": a Task goes under a User Story or Bug, not under a Feature.',
      });
    });
  });

  describe("assignment rules", () => {
    const base = { callerAgentId: "me", targetAgentId: "other", item: { type: "Task", tags: null as unknown } };
    const mine = { agentId: "me", userId: null };
    const theirs = { agentId: "someone", userId: null };
    const nobody = { agentId: null, userId: null };

    it.each([
      // role, linked task, parent's assignee, target, allowed, rule
      ["planner", theirs, null, "other", true, "assign-any"],
      ["director", theirs, null, "other", true, "assign-any"],
      ["builder", mine, null, "other", true, "hand-off"],
      ["reviewer", mine, null, "other", true, "hand-off"],
      ["architect", null, "me", "other", true, "under-own-parent"],
      ["builder", nobody, "me", "other", true, "under-own-parent"],
      ["builder", null, null, "me", true, "claim"],
      ["architect", nobody, "someone", "me", true, "claim"],
      ["builder", theirs, "me", "other", false, "hand-off"],
      ["builder", theirs, null, "me", false, "hand-off"],
      ["builder", { agentId: null, userId: "josh" }, "me", "me", false, "person"],
      ["planner", { agentId: null, userId: "josh" }, null, "other", false, "person"],
      ["director", { agentId: null, userId: "josh" }, null, "me", false, "person"],
      ["builder", null, "someone", "other", false, "under-own-parent"],
      ["builder", null, null, "other", false, "under-own-parent"],
      ["readonly", mine, "me", "me", false, "readonly"],
    ] as const)("%s, task %j, parent %s, to %s: %s (%s)", (role, current, parent, target, allowed, rule) => {
      const d = decideAssignment({ ...base, role: role as AdoRole, current, parentAssigneeAgentId: parent, targetAgentId: target });
      expect(d).toMatchObject({ ok: allowed, rule });
    });

    it("looks up the parent only when it decides the outcome", () => {
      expect(assignmentNeedsParent({ ...base, role: "builder", current: null })).toBe(true);
      // A claim may fail on type and still be allowed under the caller's own parent.
      expect(assignmentNeedsParent({ ...base, role: "builder", current: null, targetAgentId: "me" })).toBe(true);
      expect(assignmentNeedsParent({ ...base, role: "builder", current: mine })).toBe(false);
      expect(assignmentNeedsParent({ ...base, role: "builder", current: mine, heldByClaim: true })).toBe(true);
      expect(assignmentNeedsParent({ ...base, role: "builder", current: { agentId: null, userId: "josh" } })).toBe(false);
      expect(assignmentNeedsParent({ ...base, role: "planner", current: null })).toBe(false);
      expect(assignmentNeedsParent({ ...base, role: "readonly", current: null })).toBe(false);
    });

    it("denials say what the caller may do instead", () => {
      expect(decideAssignment({ ...base, role: "builder", current: theirs })).toMatchObject({
        reason: expect.stringContaining("Only the agent it is assigned to, a director or a planner may."),
      });
      expect(decideAssignment({ ...base, role: "builder", current: null, parentAssigneeAgentId: null })).toMatchObject({
        reason: expect.stringContaining("You may claim it for yourself"),
      });
    });
  });

  describe("claims by role (literal)", () => {
    const claim = (role: AdoRole, type: string, tags: string | null = null) => mayClaim(role, { type, tags });

    it("builder: User Story, Bug, Task, Defect, Document; not a Review", () => {
      for (const t of ["User Story", "Bug", "Task", "Defect", "Document"]) expect(claim("builder", t)).toBe(true);
      expect(claim("builder", "Review")).toBe(false);
      expect(claim("builder", "Feature")).toBe(false);
      expect(claim("builder", "Epic")).toBe(false);
    });

    it("reviewer: only Reviews (a tag does not make a Task one)", () => {
      expect(claim("reviewer", "Review")).toBe(true);
      expect(claim("reviewer", "Task", "review")).toBe(false);
      expect(claim("reviewer", "Document")).toBe(false);
      expect(claim("reviewer", "User Story", "review")).toBe(false);
    });

    it("architect: Documents and Tasks; director and planner anything; readonly nothing", () => {
      expect(claim("architect", "Document")).toBe(true);
      expect(claim("architect", "Task", "review")).toBe(true);
      expect(claim("architect", "User Story")).toBe(false);
      expect(claim("planner", "Epic")).toBe(true);
      expect(claim("director", "Feature")).toBe(true);
      expect(claim("readonly", "Task")).toBe(false);
      expect(Object.keys(CLAIM_TYPES)).toEqual(["builder", "reviewer", "architect", "author", "qa"]);
      expect(claim("author", "Document")).toBe(true);
      expect(claim("author", "User Story")).toBe(false);
      expect(claim("author", "Task")).toBe(false);
      expect(claim("qa", "QA Test")).toBe(true);
      expect(claim("qa", "Defect")).toBe(false);
    });

    it("a refused claim says what the role may claim", () => {
      expect(
        decideAssignment({ role: "reviewer", callerAgentId: "me", targetAgentId: "me", item: { type: "Task", tags: "frontend" }, current: null, parentAssigneeAgentId: null }),
      ).toEqual({
        ok: false,
        rule: "claim",
        reason: 'Workflow rule "claim": as reviewer you may claim only Review; this is a Task. A director or planner may assign it to you.',
      });
      expect(
        decideAssignment({ role: "builder", callerAgentId: "me", targetAgentId: "me", item: { type: "Review", tags: null }, current: null, parentAssigneeAgentId: null }),
      ).toMatchObject({
        reason:
          'Workflow rule "claim": as builder you may claim only User Story, Bug, Task, Defect, Document; this is a Review. A director or planner may assign it to you.',
      });
      // Under the caller's own parent, the type does not matter.
      expect(
        decideAssignment({ role: "reviewer", callerAgentId: "me", targetAgentId: "me", item: { type: "Feature" }, current: null, parentAssigneeAgentId: "me" }),
      ).toMatchObject({ ok: true, rule: "under-own-parent" });
    });
  });

  describe("held by claim (literal)", () => {
    const held = { role: "builder" as AdoRole, callerAgentId: "me", targetAgentId: "other", item: { type: "Task" }, current: { agentId: "me", userId: null } };

    it("a claimed item is handed on only under the caller's own parent", () => {
      expect(decideAssignment({ ...held, heldByClaim: true, parentAssigneeAgentId: null })).toEqual({
        ok: false,
        rule: "claimed-hand-off",
        reason:
          "Workflow rule \"claimed-hand-off\": you hold this work item only because you claimed it, so you may hand it on only when its ADO parent's linked task is assigned to you, and it is not. A director or planner may reassign it.",
      });
      expect(decideAssignment({ ...held, heldByClaim: true, parentAssigneeAgentId: "me" })).toEqual({ ok: true, rule: "claimed-hand-off" });
      expect(decideAssignment({ ...held, heldByClaim: false })).toEqual({ ok: true, rule: "hand-off" });
      expect(decideAssignment({ ...held, heldByClaim: true, role: "planner" })).toEqual({ ok: true, rule: "assign-any" });
    });

    it("a person's task is refused to every role, with a literal message", () => {
      expect(decideAssignment({ ...held, role: "director", current: { agentId: null, userId: "josh" } })).toEqual({
        ok: false,
        rule: "person",
        reason: "Workflow rule \"person\": a person holds this work item's linked task, so no agent may take it over. Ask that person or the board.",
      });
    });
  });

  describe("final states (literal)", () => {
    it("no role moves an item out of Completed or Removed, not even to Blocked", () => {
      const moves = [
        ["Task", "Completed", "Blocked"],
        ["Task", "Completed", "In Progress"],
        ["Document", "Completed", "Blocked"],
        ["Document", "Removed", "In Progress"],
        ["Feature", "Completed", "In Progress"],
        ["Epic", "Removed", "Blocked"],
        ["Test Case", "Completed", "Ready"],
      ] as const;
      for (const role of ROLES) {
        for (const [type, from, to] of moves) expect(decideStateChange({ role, isAssignee: true, type, from, to }).ok).toBe(false);
      }
      expect(decideStateChange({ role: "director", isAssignee: true, type: "Feature", from: "Completed", to: "Blocked" })).toEqual({
        ok: false,
        rule: "final states",
        reason: 'Workflow rule "final states": Completed and Removed are final for agents. No agent may move a Feature out of Completed; Josh does that in ADO.',
      });
    });
  });

  describe("ado_get_workflow content", () => {
    it("is generated from the tables", () => {
      const data = workflowData();
      expect(data.roles.map((r) => r.role)).toEqual([...ROLES]);
      expect(data.creation.map((r) => r.type)).toEqual([...CREATION_RULES.map((r) => r.type), "*"]);
      expect(data.states).toHaveLength(STATE_RULES.length + 1);
      expect(data.assignment.map((r) => r.id)).toEqual(ASSIGNMENT_RULES.map((r) => r.id));
      expect(data.reviewRoundLimit).toBe(3);
      const text = workflowText();
      for (const r of ROLES) expect(text).toContain(`- ${r}: `);
      expect(text).toContain("- Task: planner, builder; under User Story or Bug.");
      expect(text).toContain("- Review: planner; under User Story or Bug (created with the breakdown, one per review gate).");
      expect(text).toContain("- Defect: qa, planner; under User Story or Bug (QA creates one per problem found, and assigns it to the item's owner).");
      expect(text).toContain("- Epic: director, planner; no parent.");
      expect(text).toContain("- Feature: Ready For Work: Josh (no agent) (Josh approves the breakdown; this wakes the Feature's owner, who assigns the work).");
      expect(text).toContain("- Epic: In Progress: Josh (no agent)");
      expect(text).toContain("- any other type: any state: assignee, director.");
      expect(text).toContain("- Review: Ready For Review: owner-of-parent");
      expect(text).toContain("every state change of a child wakes the owner of its parent");
      expect(text).toContain("Completed and Removed are final for agents");
      expect(text).toContain("- builder: User Story, Bug, Task, Defect, Document.");
      expect(text).toContain("- reviewer: Review.");
      expect(text).toContain("- architect: Document, Task, Review.");
      expect(text).toContain("- qa: QA Test.");
      expect(text).toContain("- no agent may take over a work item whose linked task is assigned to a person.");
      expect(data.finalStates).toEqual(["Completed", "Removed"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Through the worker
// ---------------------------------------------------------------------------

const ORG = "https://dev.azure.com/ChimeraStudioSoftware";
const BASE = `${ORG}/AI%20Testing`;
const CO = "co-1";

const AGENTS = {
  tiamat: { id: "a-tiamat", name: "Tiamat", role: "director" },
  orochi: { id: "a-orochi", name: "Orochi", role: "planner" },
  ryujin: { id: "a-ryujin", name: "Ryujin", role: "architect" },
  zhulong: { id: "a-zhulong", name: "Zhulong", role: "builder" },
  fafnir: { id: "a-fafnir", name: "Fafnir", role: "builder" },
  ladon: { id: "a-ladon", name: "Ladon", role: "reviewer" },
  hydra: { id: "a-hydra", name: "Hydra", role: "qa" },
  ghost: { id: "a-ghost", name: "Ghost", role: "builder", status: "terminated" },
  newbie: { id: "a-newbie", name: "Newbie", role: "builder", status: "pending_approval" },
  stranger: { id: "a-stranger", name: "Stranger", role: null },
} as const;
type AgentKey = keyof typeof AGENTS;

const CONFIG = {
  orgUrl: ORG,
  project: "AI Testing",
  pat: { type: "secret_ref", secretId: "pat" },
  serviceBusConnection: { type: "secret_ref", secretId: "sb" },
  agentRoles: Object.values(AGENTS)
    .filter((a) => a.role)
    .map((a) => ({ agent: a.name, role: a.role })),
};

const TYPE_STATES: Record<string, string[]> = {
  Epic: ["New", "Ready For Work", "Planning", "Documenting", "Plan Review", "In Progress", "Blocked", "Completed", "Removed"],
  Documentation: ["New", "In Progress", "Blocked", "Completed", "Removed"],
  Document: DOCUMENT_STATES,
  Feature: ["New", "Ready For Work", "Refining", "Technical Notes", "Ready For Approval", "In Progress", "Blocked", "Completed", "Removed"],
  "User Story": STORY_STATES,
  Bug: STORY_STATES,
  Task: ["New", "In Progress", "Blocked", "Completed", "Removed"],
  Review: ["New", "Ready For Review", "Changes Requested", "Blocked", "In Review", "Approved", "Completed", "Removed"],
  "QA Test": ["New", "Ready For Test", "Testing", "Failed", "Passed", "Blocked", "Completed", "Removed"],
  Defect: ["New", "Blocked", "In Progress", "Ready For Retest", "Completed", "Removed"],
};

interface Item {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  relations: Array<{ rel: string; url: string }>;
}

class FakeAdo {
  items = new Map<number, Item>();
  updates = new Map<number, Array<{ rev: number; fields: Record<string, { oldValue?: unknown; newValue: unknown }> }>>();
  writes: Array<{ method: string; url: string; body: any }> = [];
  nextId = 900;

  add(id: number, type: string, opts: { state?: string; parent?: number } = {}) {
    const fields: Record<string, unknown> = {
      "System.WorkItemType": type,
      "System.State": opts.state ?? "New",
      "System.Title": `${type} ${id}`,
      "System.AreaPath": "AI Testing\\Agents",
      "System.IterationPath": "AI Testing\\Sprint 1",
      "System.ChangedDate": "2026-11-17T00:00:00Z",
    };
    if (opts.parent) fields["System.Parent"] = opts.parent;
    this.items.set(id, { id, rev: 1, fields, relations: opts.parent ? [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${ORG}/_apis/wit/workItems/${opts.parent}` }] : [] });
    if (opts.parent) this.items.get(opts.parent)?.relations.push({ rel: "System.LinkTypes.Hierarchy-Forward", url: `${ORG}/_apis/wit/workItems/${id}` });
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.slice(BASE.length).split("?")[0]!;
    if (method !== "GET" && path !== "/_apis/wit/wiql") this.writes.push({ method, url, body });
    let m: RegExpMatchArray | null;
    if (path === "/_apis/wit/wiql") return Response.json({ workItems: [] });
    if (path === "/_apis/wit/workitemtypes") return Response.json({ value: Object.entries(TYPE_STATES).map(([name, states]) => ({ name, color: "009CCC", states: states.map((s) => ({ name: s, category: "InProgress" })) })) });
    if ((m = path.match(/^\/_apis\/wit\/workitemtypes\/(.+)\/states$/))) {
      return Response.json({ value: (TYPE_STATES[decodeURIComponent(m[1]!)] ?? ["New", "Active"]).map((name) => ({ name, category: "x" })) });
    }
    if ((m = path.match(/^\/_apis\/wit\/workItems\/(\d+)\/updates$/))) {
      const skip = Number(new URL(url).searchParams.get("$skip") ?? 0);
      return Response.json({ value: (this.updates.get(Number(m[1])) ?? []).slice(skip, skip + 200) });
    }
    if ((m = path.match(/^\/_apis\/wit\/workItems\/(\d+)\/comments$/))) {
      if (method === "POST") return Response.json({ id: 1, text: body.text, createdBy: { displayName: "AI Service" }, createdDate: "2026-11-17T00:00:00Z" });
      return Response.json({ comments: [], totalCount: 0 });
    }
    if ((m = path.match(/^\/_apis\/wit\/workitems\/(\d+)$/))) {
      const item = this.items.get(Number(m[1]));
      if (!item) return Response.json({ message: "TF401232: Work item does not exist" }, { status: 404 });
      if (method === "PATCH") {
        for (const op of body as Array<{ op: string; path: string; value: any }>) {
          if (op.op === "test" && op.value !== item.rev) return Response.json({ message: "TF26071" }, { status: 412 });
          if (op.path === "/fields/System.State") this.recordState(item, op.value);
          if (op.path.startsWith("/fields/")) item.fields[op.path.slice(8)] = op.value;
        }
        item.rev++;
      }
      return Response.json({ ...item, url: `${ORG}/_apis/wit/workItems/${item.id}` });
    }
    if ((m = path.match(/^\/_apis\/wit\/workitems\/\$(.+)$/)) && method === "POST") {
      const id = this.nextId++;
      const item: Item = { id, rev: 1, fields: { "System.WorkItemType": decodeURIComponent(m[1]!), "System.State": "New" }, relations: [] };
      for (const op of body) {
        if (op.path === "/relations/-") {
          item.relations.push(op.value);
          item.fields["System.Parent"] = Number(op.value.url.match(/(\d+)$/)[1]);
          this.items.get(item.fields["System.Parent"] as number)?.relations.push({ rel: "System.LinkTypes.Hierarchy-Forward", url: `${ORG}/_apis/wit/workItems/${id}` });
        } else item.fields[op.path.slice(8)] = op.value;
      }
      this.items.set(id, item);
      return Response.json(item);
    }
    return new Response(`unexpected ${method} ${path}`, { status: 500 });
  }

  recordState(item: Item, to: string) {
    const list = this.updates.get(item.id) ?? [];
    list.push({ rev: item.rev + 1, fields: { "System.State": { oldValue: item.fields["System.State"], newValue: to } } });
    this.updates.set(item.id, list);
  }

  /** Move an item as a person in ADO would, keeping the history. */
  move(id: number, to: string) {
    const item = this.items.get(id)!;
    this.recordState(item, to);
    item.fields["System.State"] = to;
    item.rev++;
  }
}

const originId = (id: number) => `ChimeraStudioSoftware/AI Testing/${id}`;

async function start() {
  const ado = new FakeAdo();
  const linkRepo = fakeLinkRepository();
  const cache = fakeWorkItemCacheRepository();
  const plugin = createAdoPlugin({
    recoveryDelayMs: 0,
    linkRepository: () => linkRepo,
    workItemCacheRepository: () => cache,
    listenerFactory: () => ({ close: async () => {} }),
  });
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => ado.fetch(String(input), init));
  const harness = createTestHarness({ manifest, config: CONFIG });
  (harness.ctx.secrets as { resolve: unknown }).resolve = async (ref: { secretId: string }) => (ref.secretId === "pat" ? "pat-value" : "Endpoint=sb://x/;SharedAccessKeyName=l;SharedAccessKey=k");
  harness.seed({
    agents: Object.values(AGENTS).map((a) => ({ id: a.id, companyId: CO, name: a.name, status: "status" in a ? a.status : "idle" })) as never,
  });
  const wakeups: Array<{ issueId: string; options: any }> = [];
  (harness.ctx.issues as { requestWakeup: unknown }).requestWakeup = async (issueId: string, _companyId: string, options: unknown) => {
    wakeups.push({ issueId, options });
    return { queued: true };
  };
  const comments: Array<{ issueId: string; body: string; options: unknown }> = [];
  (harness.ctx.issues as { createComment: unknown }).createComment = async (issueId: string, body: string, _companyId: string, options: unknown) => {
    comments.push({ issueId, body, options });
    return { id: "c1" };
  };
  const streamed: any[] = [];
  (harness.ctx as { streams: unknown }).streams = { open: () => {}, emit: (_c: string, e: unknown) => void streamed.push(e), close: () => {} };
  await plugin.definition.setup(harness.ctx);
  await plugin.definition.onConfigChanged!(CONFIG, { companyId: CO });

  /** A task linked to a work item (with its origin, as A2 links it). */
  function linkedTask(workItemId: number, overrides: Partial<Issue> = {}): Issue {
    const task = {
      id: `task-${workItemId}`,
      companyId: CO,
      title: `t${workItemId}`,
      identifier: `CHI-${workItemId}`,
      status: "todo",
      originKind: ADO_LINK_ORIGIN_KIND,
      originId: originId(workItemId),
      assigneeAgentId: null,
      assigneeUserId: null,
      projectId: null,
      ...overrides,
    } as Issue;
    harness.seed({ issues: [task] as never });
    void linkRepo.insert(CO, {
      issueId: task.id,
      org: "ChimeraStudioSoftware",
      project: "AI Testing",
      workItemId,
      type: "x",
      state: "New",
      url: "u",
      rev: 1,
      syncedAt: "",
    });
    return task;
  }
  /** The task a run is working on (how the tools find the caller's current task). */
  function currentTask(agent: AgentKey, runId: string, overrides: Partial<Issue> = {}) {
    harness.seed({
      issues: [{ id: `cur-${runId}`, companyId: CO, title: "current", status: "in_progress", assigneeAgentId: AGENTS[agent].id, executionRunId: runId, ...overrides }] as never,
    });
  }
  const call = (tool: string, params: unknown, agent: AgentKey, runId = `run-${agent}`) =>
    harness.executeTool<ToolResult>(tool, params, { agentId: AGENTS[agent].id, companyId: CO, runId, projectId: "" });
  const taskFor = async (workItemId: number) =>
    (await harness.ctx.issues.list({ companyId: CO, originKind: ADO_LINK_ORIGIN_KIND, originId: originId(workItemId) }))[0] ?? null;
  return { ado, harness, wakeups, streamed, comments, linkRepo, cache, linkedTask, currentTask, call, taskFor };
}

describe("ado_update_assignment", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a planner assigns anything: creates the linked task under the parent's task and project, wakes the agent, posts the note", async () => {
    const s = await start();
    s.ado.add(10, "Feature");
    s.ado.add(20, "User Story", { parent: 10 });
    s.linkedTask(10, { assigneeAgentId: AGENTS.tiamat.id, projectId: "proj-feature" });
    const res = await s.call(TOOL_NAMES.assign, { workItemId: 20, agent: "zhulong", note: "Start with the API." }, "orochi");
    expect(res.error).toBeUndefined();
    expect(res.content).toMatch(/^ADO #20 assigned to Zhulong: created task .+ for it, in To do\.$/);
    const task = (await s.taskFor(20))!;
    expect(task).toMatchObject({ status: "todo", assigneeAgentId: AGENTS.zhulong.id, parentId: "task-10", projectId: "proj-feature", title: "User Story 20" });
    expect(s.wakeups).toEqual([{ issueId: task.id, options: expect.objectContaining({ reason: "issue_assigned", contextSource: "plugin.ado.agent-assign", actorAgentId: AGENTS.orochi.id }) }]);
    expect(s.comments).toEqual([{ issueId: task.id, body: "[Orochi] Start with the API.", options: { authorAgentId: AGENTS.orochi.id } }]);
    expect(s.harness.activity.at(-1)).toMatchObject({
      message: "[Orochi] assigned ADO #20 to Zhulong",
      metadata: expect.objectContaining({ action: "work_item_assigned", targetAgentId: AGENTS.zhulong.id, created: true, parentIssueId: "task-10", projectId: "proj-feature" }),
    });
    expect(s.streamed).toContainEqual({ type: "changed", reason: "assign", workItemId: 20 });
    // Nothing is written to ADO.
    expect(s.ado.writes).toEqual([]);
  });

  it("a builder hands off its own item, defaulting to the work item of its current task", async () => {
    const s = await start();
    s.ado.add(20, "User Story");
    s.linkedTask(20, { assigneeAgentId: AGENTS.zhulong.id, status: "in_progress", executionRunId: "run-zhulong" } as never);
    const res = await s.call(TOOL_NAMES.assign, { agent: "Fafnir" }, "zhulong");
    expect(res.content).toBe("ADO #20 assigned to Fafnir: reassigned its task CHI-20.");
    expect(await s.taskFor(20)).toMatchObject({ id: "task-20", assigneeAgentId: AGENTS.fafnir.id });
    expect(s.wakeups.map((w) => w.issueId)).toEqual(["task-20"]);
  });

  it("a builder assigns an unassigned child of its own item, and the new task goes under that item's task", async () => {
    const s = await start();
    s.ado.add(20, "User Story");
    s.ado.add(30, "Task", { parent: 20 });
    s.linkedTask(20, { assigneeAgentId: AGENTS.zhulong.id, projectId: "proj-1" });
    const res = await s.call(TOOL_NAMES.assign, { workItemId: 30, agent: "Ladon" }, "zhulong");
    expect(res.error).toBeUndefined();
    expect(await s.taskFor(30)).toMatchObject({ assigneeAgentId: AGENTS.ladon.id, parentId: "task-20", projectId: "proj-1" });
    // The parent's task is found again for an existing but unassigned linked task, through the cache.
    s.ado.add(31, "Task", { parent: 20 });
    s.linkedTask(31);
    expect((await s.call(TOOL_NAMES.assign, { workItemId: 31, agent: "Ladon" }, "zhulong")).error).toBeUndefined();
  });

  it("claims an unassigned item for oneself; with no linked parent the task takes the caller's current project", async () => {
    const s = await start();
    s.ado.add(40, "Task");
    s.currentTask("fafnir", "run-fafnir", { projectId: "proj-2" } as never);
    const res = await s.call(TOOL_NAMES.assign, { workItemId: 40, agent: "Fafnir" }, "fafnir");
    expect(res.error).toBeUndefined();
    expect(await s.taskFor(40)).toMatchObject({ assigneeAgentId: AGENTS.fafnir.id, parentId: null, projectId: "proj-2" });
    // Without a current task, no project.
    s.ado.add(41, "Task");
    await s.call(TOOL_NAMES.assign, { workItemId: 41, agent: "Fafnir" }, "fafnir", "run-other");
    expect(await s.taskFor(41)).toMatchObject({ parentId: null, projectId: null });
  });

  it("refuses others' items and unassigned items under someone else's parent, writing nothing", async () => {
    const s = await start();
    s.ado.add(20, "User Story");
    s.ado.add(30, "Task", { parent: 20 });
    s.ado.add(50, "Task");
    s.linkedTask(20, { assigneeAgentId: AGENTS.zhulong.id });
    s.linkedTask(30, { assigneeAgentId: AGENTS.ladon.id });
    const theirs = await s.call(TOOL_NAMES.assign, { workItemId: 30, agent: "Fafnir" }, "fafnir");
    expect(theirs.error).toMatch(/^Workflow rule "hand-off": the work item's linked task is assigned to someone else.*Read the rules with ado_get_workflow\.$/);
    const notMine = await s.call(TOOL_NAMES.assign, { workItemId: 20, agent: "Ladon" }, "fafnir");
    expect(notMine.error).toMatch(/hand-off/);
    const loose = await s.call(TOOL_NAMES.assign, { workItemId: 50, agent: "Ladon" }, "fafnir");
    expect(loose.error).toMatch(/^Workflow rule "under-own-parent"/);
    expect(await s.taskFor(30)).toMatchObject({ assigneeAgentId: AGENTS.ladon.id });
    expect(await s.taskFor(50)).toBeNull();
    expect(s.wakeups).toEqual([]);
  });

  it("readonly may not assign; a terminated or unknown target is refused", async () => {
    const s = await start();
    s.ado.add(40, "Task");
    expect((await s.call(TOOL_NAMES.assign, { workItemId: 40, agent: "Stranger" }, "stranger")).error).toMatch(/^Permission denied: Stranger has the ADO role "readonly"/);
    expect((await s.call(TOOL_NAMES.assign, { workItemId: 40, agent: "Ghost" }, "orochi")).error).toBe("Ghost has been terminated and cannot take work");
    expect((await s.call(TOOL_NAMES.assign, { workItemId: 40, agent: "Nobody" }, "orochi")).error).toBe('No agent called "Nobody" was found in this company.');
    expect(await s.taskFor(40)).toBeNull();
  });
});

describe("ado_create_work_item", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates an Epic or a Bug with no parent; refuses a parent for them and a missing one for others", async () => {
    const s = await start();
    s.ado.add(10, "Feature");
    const epic = await s.call(TOOL_NAMES.createWorkItem, { type: "Epic", title: "Intake" }, "tiamat");
    expect(epic.content).toMatch(/^Created Epic #900 "Intake": /);
    expect(s.ado.writes[0]!.body).toEqual([
      { op: "add", path: "/fields/System.Title", value: "Intake" },
      { op: "add", path: "/fields/System.History", value: "[Tiamat] Created." },
      { op: "add", path: "/fields/System.Tags", value: "agent:Tiamat" },
    ]);
    expect(s.harness.activity.at(-1)).toMatchObject({ message: "[Tiamat] created Epic ADO #900", metadata: expect.objectContaining({ parentId: null, rule: "create Epic" }) });
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Bug", title: "b" }, "orochi")).error).toBeUndefined();
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Epic", title: "x", parentId: 10 }, "tiamat")).error).toBe(
      'Workflow rule "create Epic": an Epic has no parent. Leave parentId out. Read the rules with ado_get_workflow.',
    );
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Feature", title: "x" }, "orochi")).error).toMatch(/^No parentId was given and this run is not working on a task/);
    expect(s.ado.writes).toHaveLength(2);
  });

  it("follows the creation table: director makes Documentation and Documents, not Features", async () => {
    const s = await start();
    s.ado.add(1, "Epic");
    s.ado.add(2, "Documentation", { parent: 1 });
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Documentation", title: "Docs", parentId: 1 }, "tiamat")).error).toBeUndefined();
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Document", title: "D1", parentId: 2 }, "tiamat")).error).toBeUndefined();
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Document", title: "D1", parentId: 1 }, "tiamat")).error).toMatch(/a Document goes under a Documentation, not under an Epic/);
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Feature", title: "F", parentId: 1 }, "tiamat")).error).toMatch(/only the planner role may create Feature/);
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Feature", title: "F", parentId: 1 }, "ryujin")).error).toMatch(/^Permission denied: Ryujin has the ADO role "architect"/);
  });

  it("assignTo assigns the new item under the same rules, placing the task under the parent's task", async () => {
    const s = await start();
    s.ado.add(20, "User Story");
    s.ado.add(21, "User Story");
    s.linkedTask(20, { assigneeAgentId: AGENTS.zhulong.id, projectId: "proj-1" });
    const res = await s.call(TOOL_NAMES.createWorkItem, { type: "Task", title: "Task", parentId: 20, assignTo: "Fafnir" }, "zhulong");
    expect(res.error).toBeUndefined();
    expect(res.content).toMatch(/^Created Task #900 "Task" under #20: .+\nADO #900 assigned to Fafnir: created task .+ for it, in To do\.$/);
    expect(res.data).toMatchObject({ workItemId: 900, type: "Task", assignment: { agentId: AGENTS.fafnir.id, created: true } });
    expect(await s.taskFor(900)).toMatchObject({ assigneeAgentId: AGENTS.fafnir.id, parentId: "task-20", projectId: "proj-1" });
    expect(s.harness.activity.map((a) => a.message)).toEqual(["[Zhulong] created Task ADO #900 under #20", "[Zhulong] assigned ADO #900 to Fafnir"]);

    // Under a story that is not the builder's: refused before anything is created.
    const writes = s.ado.writes.length;
    const refused = await s.call(TOOL_NAMES.createWorkItem, { type: "Task", title: "x", parentId: 21, assignTo: "Fafnir" }, "zhulong");
    expect(refused.error).toMatch(/^Nothing was created: Workflow rule "under-own-parent"/);
    expect(s.ado.writes).toHaveLength(writes);
  });
});

describe("ado_update_state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lets the author move a Document through its pull request; Josh asks for changes", async () => {
    const s = await start();
    s.ado.add(60, "Document");
    s.linkedTask(60, { assigneeAgentId: AGENTS.fafnir.id });
    const set = (state: string, agent: AgentKey = "fafnir") => s.call(TOOL_NAMES.setState, { workItemId: 60, state }, agent);
    expect((await set("In Progress")).error).toBeUndefined();
    expect((await set("In Review")).error).toBeUndefined();
    expect((await set("Changes Requested")).error).toMatch(/Changes Requested on a Document may be set by no agent; Josh sets it in ADO/);
    s.ado.move(60, "Changes Requested");
    expect((await set("In Progress")).error).toBeUndefined();
    expect((await set("In Review")).error).toBeUndefined();
    expect((await set("Completed")).error).toBeUndefined();
    expect((await set("In Progress")).error).toMatch(/Workflow rule "final states"/);
  });

  it("a User Story goes from build to review to merge to test to done, each step gated by its children", async () => {
    const s = await start();
    s.ado.add(70, "User Story");
    s.ado.add(71, "Review", { parent: 70 });
    s.ado.add(72, "QA Test", { parent: 70 });
    s.ado.add(73, "Task", { parent: 70 });
    s.linkedTask(70, { assigneeAgentId: AGENTS.zhulong.id });
    s.linkedTask(71, { assigneeAgentId: AGENTS.ladon.id });
    s.linkedTask(72, { assigneeAgentId: AGENTS.hydra.id });
    const set = (id: number, state: string, agent: AgentKey) => s.call(TOOL_NAMES.setState, { workItemId: id, state }, agent);
    const state = (id: number) => s.ado.items.get(id)!.fields["System.State"];

    expect((await set(70, "In Progress", "zhulong")).error).toBeUndefined();
    // Only the Story's owner hands the Review over; the reviewer cannot pick it up early.
    expect((await set(71, "Ready For Review", "ladon")).error).toMatch(/You are reviewer and not the owner of its parent\./);
    expect((await set(71, "Ready For Review", "zhulong")).error).toBeUndefined();
    expect((await set(70, "In Review", "zhulong")).error).toBeUndefined();
    expect((await set(70, "Ready To Merge", "zhulong")).error).toBe(
      "Not changed: #70 has Reviews that are not Approved (#71 Ready For Review). Set Ready To Merge when every Review under it is Approved; you are woken when one changes.",
    );
    // The reviewer cannot move the Story; it asks for changes on its own Review.
    expect((await set(70, "In Progress", "ladon")).error).toMatch(/not the assignee/);
    expect((await set(71, "In Review", "ladon")).error).toBeUndefined();
    expect((await set(71, "Changes Requested", "ladon")).error).toBeUndefined();
    expect((await set(71, "Ready For Review", "zhulong")).error).toBeUndefined();
    expect((await set(71, "Approved", "ladon")).error).toBeUndefined();
    expect((await set(70, "Ready To Merge", "zhulong")).error).toBeUndefined();
    // Josh merges; the builder hands it to QA.
    expect((await set(70, "In Testing", "zhulong")).error).toBeUndefined();
    expect((await set(72, "Ready For Test", "zhulong")).error).toBeUndefined();
    expect((await set(72, "Testing", "hydra")).error).toBeUndefined();
    expect((await set(72, "Failed", "hydra")).error).toBeUndefined();
    // QA files a Defect under the Story and gives it to the Story's owner.
    const defect = await s.call(TOOL_NAMES.createWorkItem, { type: "Defect", title: "Greeting is wrong", description: "cat README.md shows Hi; expected Hello", parentId: 70, assignTo: "Zhulong" }, "hydra");
    expect(defect.error).toBeUndefined();
    expect(defect.data).toMatchObject({ type: "Defect", assignment: { agentId: AGENTS.zhulong.id } });
    const defectId = (defect.data as { workItemId: number }).workItemId;
    expect((await set(70, "Completed", "zhulong")).error).toBe(
      `Not changed: #70 is not done testing (QA Test #72 Failed, Defect #${defectId} New). Set Completed when every QA Test is Passed and every Defect is Completed; you are woken when one changes.`,
    );
    expect((await set(defectId, "In Progress", "zhulong")).error).toBeUndefined();
    expect((await set(defectId, "Ready For Retest", "zhulong")).error).toBeUndefined();
    expect((await set(defectId, "Completed", "zhulong")).error).toMatch(/may be set by a qa/);
    expect((await set(72, "Ready For Test", "zhulong")).error).toBeUndefined();
    expect((await set(72, "Passed", "hydra")).error).toBeUndefined();
    expect((await set(defectId, "Completed", "hydra")).error).toBeUndefined();
    const done = await set(70, "Completed", "zhulong");
    expect(done.error).toBeUndefined();
    expect(done.content).toBe("Work item #70 moved from In Testing to Completed. Closed with it: #71, #72.");
    expect([state(70), state(71), state(72), state(73)]).toEqual(["Completed", "Completed", "Completed", "New"]);
  });

  it("refuses Ready To Merge with no Review, and the 3rd Changes Requested since the last approval", async () => {
    const s = await start();
    s.ado.add(80, "Bug");
    s.linkedTask(80, { assigneeAgentId: AGENTS.zhulong.id });
    expect((await s.call(TOOL_NAMES.setState, { workItemId: 80, state: "Ready To Merge" }, "zhulong")).error).toMatch(/^Not changed: #80 has no Review under it\./);
    s.ado.add(81, "Review", { parent: 80 });
    s.linkedTask(81, { assigneeAgentId: AGENTS.ladon.id });
    const review = (state: string) => s.call(TOOL_NAMES.setState, { workItemId: 81, state }, "ladon");
    s.ado.move(81, "Changes Requested");
    s.ado.move(81, "Approved");
    s.ado.move(81, "Changes Requested");
    s.ado.move(81, "Ready For Review");
    expect((await review("Changes Requested")).error).toBeUndefined();
    s.ado.move(81, "Ready For Review");
    expect((await review("Changes Requested")).error).toMatch(/^Not changed: this would be round 3 of changes on Review #81 since it last approved/);
    expect((await review("Blocked")).error).toBeUndefined();
  });

  it("applies the Feature and Epic rows: the planner refines and plans, nobody sets Ready For Work or approves the plan", async () => {
    const s = await start();
    s.ado.add(10, "Feature");
    s.ado.add(1, "Epic", { state: "Planning" });
    expect((await s.call(TOOL_NAMES.setState, { workItemId: 10, state: "Refining" }, "orochi")).error).toBeUndefined();
    expect((await s.call(TOOL_NAMES.setState, { workItemId: 10, state: "Ready For Approval" }, "orochi")).error).toBeUndefined();
    expect((await s.call(TOOL_NAMES.setState, { workItemId: 10, state: "Ready For Work" }, "orochi")).error).toMatch(/may be set by no agent; Josh sets it in ADO/);
    expect((await s.call(TOOL_NAMES.setState, { workItemId: 10, state: "Ready For Work" }, "ryujin")).error).toMatch(/may be set by no agent/);
    expect((await s.call(TOOL_NAMES.setState, { workItemId: 10, state: "In Progress" }, "tiamat")).error).toBeUndefined();
    expect((await s.call(TOOL_NAMES.setState, { workItemId: 1, state: "Plan Review" }, "orochi")).error).toBeUndefined();
    expect((await s.call(TOOL_NAMES.setState, { workItemId: 1, state: "In Progress" }, "orochi")).error).toBe(
      'Workflow rule "Epic: In Progress": In Progress on an Epic may be set by no agent; Josh sets it in ADO. Read the rules with ado_get_workflow.',
    );
    expect((await s.call(TOOL_NAMES.setState, { workItemId: 1, state: "New" }, "tiamat")).error).toMatch(/Workflow rule "Epic: New"/);
  });

  it("a reviewer moves its own review Task; a readonly assignee cannot", async () => {
    const s = await start();
    s.ado.add(30, "Task");
    s.linkedTask(30, { assigneeAgentId: AGENTS.ladon.id });
    expect((await s.call(TOOL_NAMES.setState, { workItemId: 30, state: "In Progress" }, "ladon")).error).toBeUndefined();
    s.ado.add(31, "Task");
    s.linkedTask(31, { assigneeAgentId: AGENTS.stranger.id });
    expect((await s.call(TOOL_NAMES.setState, { workItemId: 31, state: "In Progress" }, "stranger")).error).toMatch(/^Permission denied/);
  });
});

describe("ado_get_workflow", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the rules as text and data, with the caller's role, for anyone", async () => {
    const s = await start();
    const res = await s.call(TOOL_NAMES.getWorkflow, {}, "stranger");
    expect(res.error).toBeUndefined();
    expect(res.content).toMatch(/^You are Stranger, ADO role readonly\.\n\nADO workflow rules/);
    expect(res.content).toContain(workflowText());
    expect(res.content).toContain(`- builder: ${ROLE_POLICIES.builder.tools.join(", ")}`);
    expect(res.data).toMatchObject({ you: { agent: "Stranger", role: "readonly" }, ...workflowData() });
    expect(s.ado.writes).toEqual([]);
  });

  it("works without an ADO connection", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    harness.seed({ agents: [{ id: "a-1", companyId: CO, name: "Tiamat" }] as never });
    await createAdoPlugin({ recoveryDelayMs: 0 }).definition.setup(harness.ctx);
    const res = await harness.executeTool<ToolResult>(TOOL_NAMES.getWorkflow, {}, { agentId: "a-1", companyId: CO, runId: "r", projectId: "" });
    expect(res.error).toBeUndefined();
    expect(res.content).toContain("ADO workflow rules");
  });
});

describe("review fixes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a claimed item cannot be handed on unless its parent's task is the claimer's; an assigned one can", async () => {
    const s = await start();
    s.ado.add(50, "Task");
    expect((await s.call(TOOL_NAMES.assign, { workItemId: 50, agent: "Fafnir" }, "fafnir")).error).toBeUndefined();
    const task = (await s.taskFor(50))!;
    expect(s.harness.getState({ scopeKind: "issue", scopeId: task.id, stateKey: "ado-assignment-holder" })).toEqual({ agentId: AGENTS.fafnir.id, kind: "claimed" });
    expect((await s.call(TOOL_NAMES.assign, { workItemId: 50, agent: "Ladon" }, "fafnir")).error).toBe(
      "Workflow rule \"claimed-hand-off\": you hold this work item only because you claimed it, so you may hand it on only when its ADO parent's linked task is assigned to you, and it is not. A director or planner may reassign it. Read the rules with ado_get_workflow.",
    );
    expect(await s.taskFor(50)).toMatchObject({ assigneeAgentId: AGENTS.fafnir.id });

    // Under the claimer's own story, the hand-off is allowed.
    s.ado.add(20, "User Story");
    s.ado.add(30, "Task", { parent: 20 });
    s.linkedTask(20, { assigneeAgentId: AGENTS.fafnir.id });
    expect((await s.call(TOOL_NAMES.assign, { workItemId: 30, agent: "Fafnir" }, "fafnir")).error).toBeUndefined();
    expect((await s.call(TOOL_NAMES.assign, { workItemId: 30, agent: "Ladon" }, "fafnir")).error).toBeUndefined();

    // Assigned by a planner: an ordinary hand-off.
    s.ado.add(51, "Task");
    await s.call(TOOL_NAMES.assign, { workItemId: 51, agent: "Fafnir" }, "orochi");
    expect(s.harness.getState({ scopeKind: "issue", scopeId: (await s.taskFor(51))!.id, stateKey: "ado-assignment-holder" })).toEqual({
      agentId: AGENTS.fafnir.id,
      kind: "assigned",
      byAgentId: AGENTS.orochi.id,
    });
    expect((await s.call(TOOL_NAMES.assign, { workItemId: 51, agent: "Ladon" }, "fafnir")).error).toBeUndefined();
  });

  it("claims are limited to the types the role works on", async () => {
    const s = await start();
    s.ado.add(52, "Review");
    s.ado.add(53, "Feature");
    expect((await s.call(TOOL_NAMES.assign, { workItemId: 52, agent: "Fafnir" }, "fafnir")).error).toMatch(/^Workflow rule "claim": as builder you may claim only .*this is a Review\./);
    expect((await s.call(TOOL_NAMES.assign, { workItemId: 53, agent: "Ryujin" }, "ryujin")).error).toMatch(/^Workflow rule "claim": as architect you may claim only Document, Task, Review; this is a Feature\./);
    expect((await s.call(TOOL_NAMES.assign, { workItemId: 52, agent: "Ladon" }, "ladon")).error).toBeUndefined();
  });

  it("decides the parent rule from a live read of System.Parent, not the cache", async () => {
    const s = await start();
    s.ado.add(20, "User Story");
    s.ado.add(21, "User Story");
    s.ado.add(30, "Task", { parent: 21 });
    s.linkedTask(20, { assigneeAgentId: AGENTS.zhulong.id });
    s.linkedTask(30);
    // A stale cache row still says #30 is under Zhulong's story #20.
    await s.cache.upsert(CO, { org: "ChimeraStudioSoftware", project: "AI Testing" }, {
      id: 30, parentId: 20, type: "Task", typeColor: null, title: "t", state: "New", stateCategory: null, stackRank: null, url: "u", rev: 99, changedDate: null, syncedAt: "2026-11-17T00:00:00Z",
    });
    expect((await s.call(TOOL_NAMES.assign, { workItemId: 30, agent: "Ladon" }, "zhulong")).error).toMatch(/^Workflow rule "under-own-parent"/);
  });

  it("re-checks the rights against the winning task when another link wins the race", async () => {
    const s = await start();
    s.ado.add(54, "Task");
    const winner = { id: "winner", companyId: CO, title: "w", identifier: "CHI-99", status: "todo", originKind: "manual", assigneeAgentId: AGENTS.ladon.id, assigneeUserId: null } as Issue;
    s.harness.seed({ issues: [winner] as never });
    const realInsert = s.linkRepo.insert.bind(s.linkRepo);
    s.linkRepo.insert = async (companyId, link) => {
      await realInsert(companyId, { ...link, issueId: winner.id });
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    };
    const res = await s.call(TOOL_NAMES.assign, { workItemId: 54, agent: "Fafnir" }, "fafnir");
    expect(res.error).toMatch(/^Workflow rule "hand-off": the work item's linked task is assigned to someone else/);
    expect(await s.harness.ctx.issues.get("winner", CO)).toMatchObject({ assigneeAgentId: AGENTS.ladon.id });
    expect(s.wakeups).toEqual([]);
  });

  it("the planner creates Reviews and QA Tests under a Story or Bug; a builder may not", async () => {
    const s = await start();
    s.ado.add(20, "User Story");
    s.ado.add(25, "Document");
    s.linkedTask(20, { assigneeAgentId: AGENTS.zhulong.id });
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Review", title: "Code review", parentId: 20 }, "orochi")).error).toBeUndefined();
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "qa test", title: "Test it", parentId: 20 }, "orochi")).data).toMatchObject({ type: "QA Test" });
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Review", title: "x", parentId: 20 }, "zhulong")).error).toMatch(
      /^Workflow rule "create Review": only the planner role may create Review work items/,
    );
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Review", title: "x", parentId: 25 }, "orochi")).error).toMatch(
      /^Workflow rule "create Review": a Review goes under a User Story or Bug, not under a Document\./,
    );
  });


  it("assignTo checks the target before creating anything", async () => {
    const s = await start();
    s.ado.add(1, "Epic");
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Feature", title: "F", parentId: 1, assignTo: "Ghost" }, "orochi")).error).toBe(
      "Nothing was created: Ghost has been terminated and cannot take work.",
    );
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Feature", title: "F", parentId: 1, assignTo: "Newbie" }, "orochi")).error).toBe(
      "Nothing was created: Newbie is awaiting approval and cannot take work yet.",
    );
    expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Feature", title: "F", parentId: 1, assignTo: "Nobody" }, "orochi")).error).toBe(
      'No agent called "Nobody" was found in this company.',
    );
    expect(s.ado.writes).toEqual([]);
  });

  it("no agent moves an item out of Completed or Removed", async () => {
    const s = await start();
    s.ado.add(55, "Task", { state: "Completed" });
    s.linkedTask(55, { assigneeAgentId: AGENTS.fafnir.id });
    expect((await s.call(TOOL_NAMES.setState, { workItemId: 55, state: "Blocked" }, "fafnir")).error).toBe(
      'Workflow rule "final states": Completed and Removed are final for agents. No agent may move a Task out of Completed; Josh does that in ADO. Read the rules with ado_get_workflow.',
    );
    s.ado.add(56, "Feature", { state: "Removed" });
    expect((await s.call(TOOL_NAMES.setState, { workItemId: 56, state: "In Progress" }, "tiamat")).error).toMatch(/^Workflow rule "final states"/);
    expect(s.ado.writes).toEqual([]);
  });

  it("no agent, not even a planner, takes over a task a person holds", async () => {
    const s = await start();
    s.ado.add(57, "Task");
    s.linkedTask(57, { assigneeUserId: "josh" });
    for (const agent of ["orochi", "tiamat", "fafnir"] as const) {
      expect((await s.call(TOOL_NAMES.assign, { workItemId: 57, agent: "Fafnir" }, agent)).error).toBe(
        'Workflow rule "person": a person holds this work item\'s linked task, so no agent may take it over. Ask that person or the board. Read the rules with ado_get_workflow.',
      );
    }
    expect(await s.taskFor(57)).toMatchObject({ assigneeUserId: "josh", assigneeAgentId: null });
  });
});
