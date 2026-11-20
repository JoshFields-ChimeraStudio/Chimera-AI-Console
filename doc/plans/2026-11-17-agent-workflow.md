# Agents assigning ADO work items and following the workflow

Requested by Josh, November 2026. This builds on the ADO integration (`doc/plans/2026-11-14-ado-integration.md`) and the Backlog view (`doc/plans/2026-11-17-backlog-view.md`).

## Goal

Agents run the ADO workflow themselves. Josh assigns an Epic to Tiamat. Tiamat creates the Documentation and Document items and assigns each Document to its author. After planning, Orochi creates the delivery work items and assigns them to the engineers. Each agent moves its items from state to state as the work goes through its lifecycle, and an agent can hand an item to another agent when needed.

Assigning a work item always means assigning its linked Paperclip task, never ADO's "Assigned To", as in the Backlog view.

**Single source.** The state and assignment rules below are the enforcement copy, implemented in the plugin (`packages/plugins/plugin-ado/src/workflow/`). Agents read them with the `ado_get_workflow` tool. Once this lands, the `story-workflow` skill's States table and the matching parts of `ADO-WORKFLOW-PROPOSAL.md` (both in the AI Team folder) should point to the tool instead of repeating the rules. That skill edit is a follow-up and not part of this change.

## Roles

The plugin's **Agent roles** setting. The full set (`qa` added November 2026 with the QA Test type):

| Role | Who (today) | Notes |
|---|---|---|
| `director` | Tiamat | Intake, Epic and Documentation, assigning approved work, Feature and Epic roll-up |
| `planner` | Orochi | The plan and the work item tree: Features, Stories, Tasks, Reviews and QA Tests |
| `architect` | Ryujin, Fafnir | Technical notes (`ado_update_technical_notes`), Ready For Approval, architecture Documents and Reviews |
| `author` | Zhulong, Fucanglong, Kukulkan | Their own Documents (product analysis, technical design documents, designs), each as a pull request; may claim only Documents and create nothing (added 19 November 2026) |
| `builder` | Engineers (Hydra, Yinglong, Ouroboros, Jormungandr, …) | Their own Stories, Bugs, Documents, Tasks and Defects |
| `reviewer` | Ladon and the other gate agents | Their own Reviews |
| `qa` | QA testers | Their own QA Tests, and the Defects they find |
| `readonly` | Anyone not listed | Read only |

Some state rights are "the item's **assignee**": the agent whose linked Paperclip task is the work item's. The tool rights below still apply on top. For example, a `readonly` agent cannot change state even if it is the assignee.

Tool rights per role (`src/tools/roles.ts`; the A8 section of `doc/plans/2026-11-14-ado-integration.md` points here). What a role then does with a tool is limited by the rules in the sections below.

| Tool | readonly | reviewer, qa | author, builder | architect | director, planner |
|---|---|---|---|---|---|
| `ado_get_work_item`, `ado_get_workflow`, `ado_get_pr_threads` | yes | yes | yes | yes | yes |
| `ado_post_comment`, `ado_update_state`, `ado_update_assignment`, `ado_post_pr_comment` | | yes | yes | yes | yes |
| `ado_create_pr_link`, `ado_create_pull_request` | | | yes | yes | yes |
| `ado_update_technical_notes` | | | | yes | yes |
| `ado_create_work_item` | | qa only | builder only | | yes |

The create tool goes to the roles the creation table below names, so an architect has none.

## Assigning work items (`ado_update_assignment`)

The tool is named `ado_update_assignment` because the host rates a tool "write" only if its name has a write verb, and "assign" is not one (`inferToolRisk` in `server/src/services/tool-gateway.ts`). It takes a work item ID and a target agent (by name), and an optional note. It creates the linked task if there is none, or reassigns the existing one, puts it in To do and wakes the target agent, through the same code as the Backlog view's assign (`src/backlog/assign.ts`). Without a work item ID it uses the work item of the caller's current task. The note is posted on the linked task as a comment by the calling agent, before the wakeup; nothing is written to ADO.

Who may assign:
- **No agent** (any role, including `director` and `planner`) may take over a work item whose linked task is assigned to a person (a user assignee). The tool says a person holds it.
- **`director` and `planner`** may assign any other work item to any agent.
- **Other roles except `readonly`** may:
  - hand off a work item whose linked task was assigned to them, to any agent;
  - hand off a work item they hold only because they claimed it, only when its ADO parent's linked task is assigned to them (the same condition as the next rule), so a claim cannot be used to get round it;
  - assign an unassigned work item whose ADO parent's linked task is assigned to them, to any agent (for example a builder assigning a Task under its own Story);
  - assign an unassigned work item to the agent its ADO parent's linked task is assigned to (QA assigns a Defect to the Story's owner);
  - claim an unassigned work item for themselves, of the types their role works on: `builder` User Story, Bug, Task, Defect, Document; `reviewer` Review; `architect` Document, Task, Review; `qa` QA Test.
- **`readonly`** may not assign.
- **The target agent** must belong to the company and be neither terminated nor awaiting approval (also for the Backlog view's assign, and for `assignTo`, which checks it before creating the item).

How it is decided: the ADO parent is read live from ADO (`System.Parent`), never from the cache. How the current agent came to hold a linked task is kept in plugin state per task ("claimed" or "assigned" by an agent or user), written by every assignment through the plugin and valid only while that agent still holds the task; a task assigned outside the plugin counts as assigned. If another link wins a race to create the linked task, the rules are checked again against the winning task before it is changed.

**Where the task goes.** A new linked task becomes a child of the ADO parent's linked task, if the parent has one, so the Paperclip task tree mirrors the ADO tree (Feature → Story → Review), as `story-workflow` describes. It takes that parent task's Paperclip project. Without a linked parent it takes the project of the calling agent's current task, or none. The Backlog view's assign places a new task under the parent's linked task the same way. Upstream Paperclip limits plugin-created tasks to two levels (`doc/plans/2026-11-05-two-level-task-hierarchy.md`); the fork lets shipped plugins nest at any depth (`CLAUDE.md` fork patch 10), so the tree keeps its full depth.

## Creating work items (`ado_create_work_item`)

This replaces `ado_create_child_work_item`. The parent is optional: an Epic or a Bug has none, and every other type needs one. An optional `assignTo` assigns the new item in the same call, under the assignment rules above; those rules are checked before the item is created. Without `parentId`, a type that needs a parent takes the work item of the caller's current task as its parent, as before. An optional `acceptanceCriteria` (plain text) fills the Acceptance Criteria field of an Epic, Feature or User Story; for any other type the call is refused before anything is created, and the criteria belong in the description. `ado_get_work_item` returns the technical notes (`Custom.TechnicalNotes`) alongside the acceptance criteria.

Who may create which type:

| Type | May create | Parent |
|---|---|---|
| Epic | director, planner | none |
| Documentation | director, planner | Epic |
| Document | director, planner | Documentation |
| Feature | planner | Epic |
| User Story | planner | Feature |
| Bug | planner (Josh in ADO) | none |
| Task | planner, builder | User Story or Bug |
| Review | planner (with the breakdown, one per review gate) | User Story or Bug |
| QA Test | planner (with the breakdown) | User Story or Bug |
| Defect | qa, planner (QA, one per problem found, assigned to the item's owner) | User Story or Bug |
| any other type | planner | as ADO allows |

## Who owns what

Redesigned November 2026, after the #820 and #823 tests stalled (a reviewer moving the Story it reviewed, and nothing telling the builder when its Review finished). Josh's flow (Lucid chart "ADO Workflow"): Epic → Documentation → plan → Josh approves → the planner builds the whole tree, Reviews and QA Tests included → technical notes → Josh approves → work is assigned → build → review → merge → test → done.

- **One owner per item.** Only an item's owner (the agent on its linked task) moves it. Others signal through their own items: the reviewer through its Review, QA through its QA Test and the Defects it files.
- **Children report to their parent's owner.** Every state change of a work item by anyone other than the owner of its parent wakes that owner (`src/watch/`, reason `ado_child_changed`). A Review approved wakes the builder; a Story completed wakes the Feature's owner; a Feature completed wakes the Epic's owner.
- **Handing over is a state.** The builder sets its Story's Review to `Ready For Review` and its QA Test to `Ready For Test`, and fixes a Defect to `Ready For Retest`. Each wakes that item's assignee, because someone else changed their item.
- **The planner may run the Documentation step** (create Documentation and Documents, set Epic Documenting and the Documentation's states) so a team without a director, like the test team, can do it; on the real team Tiamat does.
- **Technical notes** are written with `ado_update_technical_notes` (Custom.TechnicalNotes, on Epic, Feature, User Story, Bug and Task). The planner sets the Feature to Technical Notes and hands it to the architect, who writes the notes, sets Ready For Approval and hands the Feature back.
- **Roll-ups are the plugin's (A4, 19 November 2026).** A Feature, Epic or Documentation item that is In Progress is set Completed by the plugin once every item under it is Completed or Removed (at least one Completed), signed `[ADO plugin]` in its history (`ROLLUP_RULES` in `src/workflow/rules.ts`, done in `src/watch/`). While the parent is In Progress its owner is not woken for its children's ordinary moves, only when a child is Blocked; this saves a planner or director run per Story move. Before that (an Epic still Documenting) the owner is told as usual, so it learns its Documentation is done.
- **Josh's instructions travel down (20 November 2026).** An `Instructions from Josh:` section at the end of an Epic's, Feature's or Story's description is copied by `ado_create_work_item` into every item created under it (not Defects), as `Instructions from Josh (copied from #<id>):`, unless the agent already wrote the same text (`src/workflow/instructions.ts`). Smoke test #848 showed why: the planner created the Feature without the Epic's instructions, so neither the Review nor the QA Test had them, the review approved at once and QA passed with no Defect.
- **Nothing closes early.** Reviews (`Approved`) and QA Tests (`Passed`) stay open until their Story or Bug is `Completed`, so a Defect fix can hand them over again. Setting the Story `Completed` closes them, in the same tool call.
- **One pull request per Story or Bug,** plus one per Defect fix, linked to the Defect and its Story. A Document's markdown goes in a pull request in the documents repository; Josh's merge is his approval.

## State rules (`ado_update_state`)

Josh set these states in ADO on 18 November 2026; they were checked live against the process. "Josh" means no agent may set the state. "Owner of the parent" (setter `owner-of-parent`) is the agent on the linked task of the item's ADO parent, read live.

| Type | State | Who may set it |
|---|---|---|
| Epic | Documenting | director, planner |
| Epic | Planning | director, planner |
| Epic | Plan Review | planner (the plan waits for Josh) |
| Epic | In Progress | Josh (his approval of the plan; wakes the planner, who builds the tree) |
| Epic | Completed, Blocked | director, planner (Completed when every Feature is) |
| Epic | Removed | Josh |
| Documentation | In Progress, Blocked, Completed | director, planner (the plugin sets Completed when every Document is final) |
| Document | In Progress, In Review, Blocked, Completed | assignee (In Review while its pull request waits for Josh; Completed when he merges it) |
| Document | Changes Requested | Josh |
| Document | Removed | director, planner |
| Feature | Refining, Technical Notes | planner |
| Feature | Ready For Approval | architect, planner (the breakdown waits for Josh) |
| Feature | Ready For Work | Josh (his approval of the breakdown; wakes the Feature's owner, who assigns the work) |
| Feature | In Progress, Completed | director, planner (Completed when every Story and Bug is) |
| Feature | Blocked | director, planner, architect |
| Feature | Removed | Josh |
| User Story, Bug | In Progress, In Review, Ready To Merge, In Testing, Completed, Blocked | assignee. `Ready To Merge` only when every Review under it is `Approved`; `Completed` only when every QA Test under it is `Passed` and every Defect `Completed`, and it closes the Reviews and QA Tests |
| User Story, Bug | Removed | planner |
| Task | In Progress, Blocked, Completed | assignee |
| Review | Ready For Review | owner of the parent (the builder hands it over; wakes the reviewer) |
| Review | In Review, Changes Requested, Approved, Blocked | assignee (the reviewer; Changes Requested and Approved wake the builder) |
| QA Test | Ready For Test | owner of the parent (after the merge; wakes the tester) |
| QA Test | Testing, Failed, Passed, Blocked | assignee (the tester; Failed comes with a Defect per problem) |
| Review, QA Test | Completed | no agent directly: closed by the tool when their Story or Bug is set Completed |
| Defect | In Progress, Ready For Retest, Blocked | assignee (the builder; Ready For Retest once the fix is merged) |
| Defect | Completed, In Progress | qa (after the retest: closed, or sent back) |
| Review, QA Test, Defect, Task | Removed | planner |
| any other type | any state | assignee, director |

The Epic's `Ready For Work` state exists in ADO but is not used.

Every type starts in `New` when it is created, so `New` is never set by this tool.

`Completed` and `Removed` are final for agents: no agent, of any role, may move an item out of them, not even to `Blocked`. Josh does that in ADO. (The `from` field of `STATE_RULES` can name a move out of a final state; no rule uses it now.)

The tool checks who may set a state, that the state exists for the type (read live from ADO), and the checks named above (`Ready To Merge`, Story `Completed`, the review round limit). It does not check the order of moves; agents follow it.

## Review rounds

- The reviewer finishes a review on its own Review: `Approved`, or `Changes Requested` with its findings on the pull request. `Blocked` keeps one meaning everywhere: an answer is needed.
- The builder fixes, pushes, replies on the threads, and sets the Review `Ready For Review` again.
- **Round limit:** the 3rd `Changes Requested` on a Review since it was last `Approved` (counted from its ADO history) is refused, and the tool says to set the Review `Blocked` with a summary for Josh instead (`REVIEW_ROUND_LIMIT` in `src/workflow/rules.ts`). A Defect fix after an approval starts the count again.
- When every Review is `Approved`, the builder sets `Ready To Merge` (Josh's turn).
- **More findings.** A reviewer asked for more (by Josh, say) sets its own Review back to `In Review` and reviews again; nothing reopens, since `Approved` is not final.
- **Pull request comments.** Reviewers on unfinished Reviews (`Approved` included) are told about others' new comments on the pull request (the builder's replies included) and reply on the thread; they re-review only when the Review is `Ready For Review` again.

## Reading the rules (`ado_get_workflow`)

Returns the role list, the assignment rules, the creation table, the state table, who owns what and the review rounds above (and that a linked task follows its work item), in a compact, readable form, plus the same as structured data, the caller's role and the tools of each role. It works without an ADO connection. Agents call it instead of relying on a copy in their instructions. Anyone may read it.

## Not in this change

- Automatic roll-ups (the Documentation state from its Documents, the Epic and Feature `In Progress` and `Blocked` from their children). For now the director sets them, as the rules allow.
- The User Story, Task and Defect levels of the proposal that are still open, and setting `Changes Requested` from a PR vote.
- Editing the skills to point to `ado_get_workflow`.
