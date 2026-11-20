# Chimera-AI-Console backlog

The single place for planned changes to this build, so the AI team works better. Created November 2026. Edit in place; when an item ships, mark it Done with the commit and move on. If we later move this into Azure DevOps, delete this file rather than keeping both.

Sizes are rough guesses (S = a day or two, M = about a week, L = multiple weeks). Priority: P1 do first, P2 next, P3 later.

## What the code already gives us

Found by searching this checkout. "Not found" means my searches turned up nothing, which is not proof.

- **Tasks:** issues have a single assignee, statuses `backlog | todo | in_progress | in_review | done | blocked | cancelled`, parent/child, blockers and relations, documents, work products, and `origin_kind` / `origin_id` columns for provenance (`packages/db/src/schema/issues.ts`, `doc/SPEC-implementation.md`).
- **Plugins:** a plugin system with typed events (`onEvent`), scheduled jobs, inbound webhooks, agent tools, its own database namespace, and UI pages/sidebar/settings (`doc/plugins/PLUGIN_SPEC.md`). The bundled LLM Wiki plugin is a good worked example.
- **Connections:** curated apps (Asana, GitHub, others) plus a generic route to connect any remote MCP server (`doc/connections/GENERIC-REMOTE-MCP.md`).
- **Azure DevOps:** not found anywhere in the repo. Today the agents reach ADO only through the ADO MCP server configured on the VM.
- **Logging:** a `heartbeat_run_events` table, an activity log, per-run transcripts as NDJSON files on the VM, run history and live log on the agent page (`ui/src/pages/AgentDetail*`), and optional OTLP export of Claude Code traces to a collector of our choosing (`doc/agent-observability.md`).
- **Agent files and config:** each agent has persistent managed files (instructions, plus notes it may create itself) that the agent can edit, and an Advanced tab that edits the whole agent configuration as one YAML document, covering instructions, skills, environment variables and secrets, and tools (`doc/agent-files.md`, `doc/agent-configuration-yaml.md`). New edits no longer keep revision history in the current editor (`doc/agent-instruction-revisions.md`).
- **Chat:** an agent chat is stored as a special kind of task (an issue) whose assignee is the chat's agent, and the database allows exactly one per agent per user (a unique index on company, agent and user, plus a check that the assignee equals the chat agent: `packages/db/src/schema/issues.ts`). The Chat page has a searchable sidebar with an agent picker and reopens your last chat. I found no delete for chats in the chat pages. There is also a separate "board concierge" chat (`BoardChat.tsx`), and external chat channels (Slack, Discord, Teams) that are unrelated to this.
- **Notifications:** an inbox exists in the app, but I found no browser or desktop notification code.
- **Memory:** a design only. `doc/plans/2026-03-17-memory-service-surface-api.md` describes company-default plus per-agent memory bindings; I found no implementation. There is also the LLM Wiki plugin, which distils issues and comments into a maintained wiki, and `doc/plans/2026-10-03-connection-instructions-and-memory-evals.md` on evaluating memory.

## Overview

| ID | Item | Pri | Size | Depends on |
|---|---|---|---|---|
| **A. ADO integration and task management** | | | | |
| A1 | Spike: plugin skeleton, event queue, MCP vs REST | P1 | S | |
| A2 | ADO work item as a first-class link on a task | P1 | done | A1 |
| A3 | ADO to Paperclip: pick up work automatically | P2 | done | A1, A2 |
| A4 | Paperclip to ADO: state sync done in code, not prompts | P1 | done | A2 |
| A5 | ADO pull request on the task, wake on review activity | P2 | L (wakes done) | A2 |
| A6 | Routing and assignment rules, WIP limits | P2 | done (queue view open) | A2 |
| A7 | Automatic agent attribution in ADO | P3 | done | A4 |
| A8 | Plugin-provided ADO tools for agents | P1 | done (MCP removal in the agent configs open) | A1 |
| A9 | Pull request tools in the plugin | P1 | done | A8 |
| A10 | Smoke-test Epic: create or reset from the plugin | P2 | done | A8 |
| A11 | Port the proven workflow to the real AI Team | P1 | done (smoke test on the VM open) | A9 |
| A12 | Per-service Paperclip project and worktree for linked tasks | P1 | done | A11 |
| **B. Logging and debugging** | | | | |
| B1 | Run explorer (replaces pull-logs and analyze-logs) | P1 | M | |
| B2 | Transcript viewer with secret redaction | P1 | M | |
| B3 | Context and session health | P2 | S | B1 |
| B4 | "Why did this run start?" trace | P2 | M | |
| B5 | Failure inbox with likely causes | P2 | M | B1 |
| B6 | Per-task timeline | P3 | M | A5 |
| B7 | Spike: OTLP to a self-hosted viewer | P3 | S | |
| B8 | Log retention and disk guardrails | P2 | S | |
| **C. Agent memory** | | | | |
| C1 | Decided: LLM Wiki plugin is the memory layer to start with | P1 | done | |
| C2 | Install and configure the LLM Wiki plugin, try it on the dummy project | P2 | M | P0, C1 |
| C3 | Review gate for wiki writes (git-backed, human approval) | P2 | M | C2 |
| C4 | Show which wiki pages each run read or wrote | P2 | M | C2, B2 |
| C5 | Retro loop: promote lessons into agent instructions | P3 | M | C3 |
| C6 | Measure whether memory helps | P3 | S | C2 |
| **D. Efficiency and agent operations** | | | | |
| D1 | Fix session resume (investigate first) | P1 | S+M | |
| D2 | Shrink the cold-start context | P1 | M | B3, D1 |
| D3 | Agent instructions: git sync, self-update with review, download/upload | P1 | M | |
| D4 | Notifications when an agent needs you (in-app, Windows) | P2 | M | |
| D5 | Per-agent skills, connectors and environment variables: find and fix the pain | P2 | discovery | |
| D6 | Automated checks before the review agent | P2 | M | |
| D7 | Proper worktree provisioning | P2 | M | |
| D8 | Docs publisher as a scheduled job (no agent) | P2 | M | C2 |
| D9 | Cost and usage visibility, including subscription usage | P2 | M-L | B1 |
| D10 | In-repo plugins ship with the code (install and update with the deploy) | P1 | done | |
| **E. Chat** | | | | |
| E1 | Delete a chat | P2 | S-M | |
| E2 | Multiple chat sessions per agent | P2 | M | |
| E3 | Group chat with several agents (design spike first) | P3 | L | E2, D1, D2, D9 |
| E4 | Turn a chat into an ADO work item or Grimoire document | P3 | M | A8, C2 |

**ADO order agreed 19 November 2026:** A9, then A4 roll-ups, then D4 (ADO events first), then A11, then A10, then D9's cost per Feature. A12 (per-service projects) was added after A11; look into it before the real team goes live.

Suggested order: the deploy path (P0) is done; then D1 (investigation) and B1/B2 (fast wins: less wasted tokens, no more manual log pulling), then D3, A1, A2, A4, A8 and D4, then the rest. The chat items (E) can follow once those are under way; E1 and E2 are independent of the rest.

## Prerequisites

- **P0. Prove the deploy path.** Build locally with `doc/LOCAL-DOCKER.md`, then install the fork on the VM with `paperclipai install --repo ... --ref master` (a managed git install that follows the `master` branch, so `paperclipai update` picks up pushes) and confirm rollback works (`CLAUDE.md`, "Deploy to the Azure VM"). Every item below relies on this loop. **Done** (verified November 2026).

## A. ADO integration and task management

Goal: ADO stays the system of record for work (pilot decision), Paperclip stays the place agents are woken and supervised, and the two stay in step without agents spending tokens on bookkeeping.

**A1. Spike: how the integration is built (P1, S).** *Done:* decisions in `doc/plans/2026-11-14-ado-integration.md`, skeleton in `packages/plugins/plugin-ado` (plugin, plain REST, a live Service Bus listener, and a catch-up that runs on startup and from a Sync now button; no polling or timers). Original scope: Options: (a) a Paperclip plugin using events, jobs and its own settings page; (b) a curated connection; (c) keep MCP-only as now. Leaning (a): it can react to Paperclip events, run scheduled jobs and add UI, while agents keep using the ADO MCP for rich operations. One real constraint: the VM is reachable only over the VPN, so ADO service hooks cannot call it directly. The cheap answer is not a classic relay but a **queue**: ADO service hooks can write events straight into an Azure Storage queue (or Service Bus queue), and the plugin polls that queue from the VM using outbound traffic only. Cost is pennies a month (see "Decisions"). Keep a slower reconciliation poll of ADO as a safety net for lost events. The spike must confirm: how ADO authenticates to the storage account (account key or service connection), the storage account's network settings so ADO can write to it, and whether a plugin can call the ADO MCP server or should call ADO's REST API directly (REST with the service-account PAT is probably simpler and easier to audit). Output: a short decision note and a thin working plugin skeleton that reads one event from the queue and fetches the work item.

**A2. ADO work item as a first-class link (P1, M).** *Done:* link and unlink on the task, chip with state, "Linked to ADO" list filter and search by ADO ID; see decision 6 and "Task UI" in `doc/plans/2026-11-14-ado-integration.md`. Original scope: Today the convention is "ADO ID in the task title". Store the ADO org/project, work item ID, type (Story, Task, Bug, Defect, Documentation), state and URL as structured data on the task (plugin entity or the `origin_*` fields, to be decided in A1). Show it as a chip with a link in the task view and list filters, and search by ADO ID.
*Done when:* every task created from ADO shows its link and current ADO state, and the title no longer needs the ID.

**A3. ADO to Paperclip (P2, L).** The Service Bus listener from A1 (plus the catch-up on startup and Sync now) tells the plugin which ADO items are ready for an agent (rule to define, for example a state or tag on a Feature the director owns) and creates or updates the Paperclip task, assigned per A6. Replaces the director doing manual intake. Must be idempotent and must never reopen finished work. **Done (20 November 2026):** the rule is a tag. Josh tags a top-level work item (an Epic, or a Bug) `for:<Agent>` in ADO; when the plugin sees it (live event, catch-up or full sync) with no linked task, it creates the task assigned to that agent and wakes it, through the Backlog view's assignment path, and comments on the item. Items with any linked task (open or finished) are never touched, final items and items with a parent are ignored (A6 routes `for:` items under Features), and the check is repeated inside the assignment lock. A tag naming no agent is reported once per tag. `src/intake/index.ts`. Work under the Epic was already automatic: assigning a work item creates its task (A2, A4), and A6 assigns approved Features' work.

**A4. State sync in code (P1, M).** Encode the rules from `skills/story-workflow` and `skills/studio-rules` (who sets which state on which work item type, Bugs vs Defects, Documentation items) as a mapping table in the plugin. When a Paperclip task changes status, the plugin updates the ADO state. Agents stop doing this through prompts, which saves tokens and removes a class of mistakes. Needs a decision on direction of truth when both change (ADO wins for humans' edits). Decided: the A8 agent tools enforce these rules too, so they live in one place.

*Partly done (November 2026):* the state rules are enforced in the agent tools (`ado_update_state`, with assignment and creation rules; `doc/plans/2026-11-17-agent-workflow.md`). The task-status-to-ADO sync is no longer wanted: since 18 November the Paperclip task follows its ADO item (agents never close tasks; the plugin closes them when the item is final). **Roll-ups done (19 November 2026):** the plugin sets a Feature, Epic or Documentation item Completed when it is In Progress and every child under it is Completed or Removed, instead of an agent run; their owners are woken by a child only when it is Blocked (`doc/plans/2026-11-17-agent-workflow.md`, "Who owns what").

**A5. Pull request on the task (P2, L).** Show the linked ADO PR on the Paperclip task: status, policy checks, reviewer votes and the `[Ladon]` / architecture review comments. Poll for new review threads and wake the builder when review is finished, instead of relying on reviewers finishing Paperclip tasks by hand. Also enforces "the next agent starts only after the PR it depends on is merged" by auto-clearing the blocker when the PR completes. **Wakes done (November 2026):** the builder is woken when its PR is completed or abandoned or gets comments from anyone else, reviewers on open Review items are told about others' comments, and review hand-offs run through Review item states (`doc/plans/2026-11-14-ado-integration.md`, "Pull request events" and "ADO drives the task"). **Open:** PR status, checks and votes shown on the task; clearing "waits for PR X" blockers on merge.

**A6. Routing and assignment (P2, M).** Rules mapping work item type / area path / tags to an agent so the director only handles exceptions; per-agent concurrency (WIP) limits so one agent isn't given five tasks at once; a queue view per agent. Keep the single-assignee invariant (`AGENTS.md` section 5). **Done (20 November 2026), without the queue view:** the planner tags a Story or Bug `builder:<role>` (`builderRole` on `ado_create_work_item`) and a Review, QA Test or Task `for:<agent>` (`forAgent`). The new **Builder routes** setting maps each role to its agents and an open-Stories limit per agent. When Josh sets a Feature Ready For Work, the plugin (before waking the Feature's owner) assigns the `for:` items and starts tagged Stories on the builder of their role holding the fewest open Stories and Bugs, below the limit, ties to the first listed; a Story whose description says `Depends on #<id>` waits for that item. When a Story or Bug is done, the next waiting Story (backlog order) gets the slot. It comments on each item it assigns and on the Feature (what it assigned, what waits and why); its own comments wake nobody. Untagged work stays with the director. `src/routing/index.ts`. The judgement of who suits a Story stays with the planner; the plugin follows the table and counts.

**A7. Automatic attribution in ADO (P3, S).** *Done* with the A8 tools: `[Name]` prefix on every comment and history entry, and an `agent:<Name>` tag for the last agent to change an item; see "A8: agent tools" in `doc/plans/2026-11-14-ado-integration.md`. Original scope: All agents share one service account, so comments and updates written by the plugin should carry the agent's name automatically (the `[Ladon]` convention), and an ADO field or tag records which agent last touched an item.

**A8. Plugin-provided ADO tools for agents (P1, M).** *Done* except the A4 state rules and removing the ADO MCP server from agents, which stay open; tools and role table in `doc/plans/2026-11-14-ado-integration.md` ("A8: agent tools"). Original scope: Decision: all agent writes to ADO go through the plugin. The plugin exposes a small set of tools to agents (read work item, comment, set state, link PR, create child item, depending on the agent's role) and performs the call itself, whether that is the MCP server or ADO's REST API underneath. Benefits: one place for permissions per agent role, automatic attribution (A7), every ADO write recorded in the Paperclip activity log, and the state rules from A4 enforced in code. Once tools reach parity, remove the direct ADO MCP server from the agents' configuration so there is only one route. **Read tools done (20 November 2026):** `ado_get_file` (a file with line numbers, 2000 lines at a time, or a folder, in any repository at a branch or commit), `ado_get_pr_changes` (a pull request's changed files, or one file's unified diff against the merge base) and `ado_search_work_items` (title text, type, state), for every role. They replace the agents' last ADO MCP uses (Grimoire files, pull request diffs, searches); the real team's instructions and the test reviewer and tester now use them, so Juniper and Willow need no git and no token. Still to do: take the ADO MCP server out of the agents' adapter configs on the VM.

**Backlog view.** *Plugin side built* (cache, `backlog` and `work-item` data, Sync, Assign to agent); the pages in `ui/src` are separate work. Design and contract in `doc/plans/2026-11-17-backlog-view.md`.

**A9. Pull request tools in the plugin (P1, M).** Builders and reviewers open pull requests, read threads and reply with curl and a personal access token (`ADO_GIT_PAT`) from their `TOOLS.md`. That is the most fragile step of the flow, puts a token in every agent, and nothing enforces the `[Name]` signature. Add plugin tools: create a pull request (linked to its work items), list threads, post a thread (optionally on a file and line), reply on a thread. Signed and logged like the other A8 tools, with role rights (builder creates; builder, reviewer and Josh-facing roles comment). *Done (19 November 2026):* `ado_create_pull_request`, `ado_get_pr_threads` and `ado_post_pr_comment` (thread or reply, file and line, thread status); see "A8: agent tools" in `doc/plans/2026-11-14-ado-integration.md`. Agents keep `ADO_GIT_PAT` only for git (clone, fetch, push); a plugin tool for the diff would remove it from reviewers and QA too.

**A10. Smoke-test Epic from the plugin (P2, S-M).** A button on the ADO plugin page that creates (or resets) a standard smoke-test Epic in the test project, written to exercise every path: a review that must ask for a change, a QA failure that files a Defect, a Document reviewed as a pull request. Run it after each plugin or server change instead of writing a test Epic by hand. Reset closes the previous smoke-test items (Removed) so the board stays clean. **Done (19 November 2026):** an "Azure DevOps smoke test" dashboard widget, on only when the new **Smoke-test agent** setting names an agent (Rowan in AI Testing; leave it empty on the real team's project). Start creates the Epic (its text is in `src/smoke/index.ts`, the one copy) and assigns it to that agent; when a smoke test already exists it first closes every open item under it, parents before children so nothing rolls up or wakes anyone (Removed, or Completed for a type with no Removed state), and creates nothing if any item could not be closed. Clean up does the closing alone. The widget lists Josh's own steps. Open pull requests of the old smoke test are left as they are (abandon them in ADO). First run (#848): the review and QA paths were not exercised because the planner dropped the Epic's instructions; `ado_create_work_item` now copies them down (`doc/plans/2026-11-17-agent-workflow.md`, "Who owns what").

**A11. Port the workflow to the real AI Team (P1, M).** The test agents (Rowan, Maple, Juniper, Willow) hold the proven flow; Tiamat, Orochi, Ryujin, Ladon and the engineers still have the old instructions. Rewrite theirs from the test agents', point the `story-workflow` skill at `ado_get_workflow` instead of repeating the rules (one source), and add a director and an architect to the test team so Documenting, Technical Notes and the Document pull request flow are tested before go-live. Do after A9 so the real team never needs the curl recipes. **Phase 1 done (19 November 2026):** an `author` role (Documents only, as pull requests), `ado_update_technical_notes`, the planner may run the Documentation step, and two test agents: Oak (architect) and Birch (author, documents in SimpleRepo `docs/`). Role mapping agreed for the real team: director Tiamat; planner Orochi (adds a Review for Ladon on every Story, plus Typhon, Mushussu or Falkor when Ryujin's or Zhulong's documents call for them; does not assign); architect Ryujin, Fafnir; author Zhulong, Fucanglong, Kukulkan; reviewer Ladon, Typhon, Mushussu, Falkor; qa Apophis; builder the engineers. TDDs are Documents under the Epic's Documentation. Phase 2: port the real agents' instructions. **Phase 2 done (19 November 2026):** `story-workflow` rewritten as the one description of the flow (roster with ADO roles, gates, each role's part, how a run ends, how to call the plugin tools), the other shared skills and all 22 agents' AGENTS.md and TOOLS.md moved to the plugin tools (the ADO MCP stays for reads only: Grimoire files, pull request diffs, searches). Gaps the plugin tools leave: no work item or PR tags, dependencies written as "Depends on #id" in the Story instead of links, no editing an item after it is created. Still to do: the agentRoles setting and a smoke test on the VM.

**A12. Per-service Paperclip project and worktree for linked tasks (P1, S-M).** A linked task takes its parent's linked task's Paperclip project, so every task under an Epic lands in the Epic task's project. The old flow put build work in the service's project (for example Products), where Paperclip gives the agent an isolated worktree of that service's repository with its `CLAUDE.md` and context. The ported instructions fall back to the agent cloning the repository its technical notes name, which may not give the agent the right context. Look into choosing the Paperclip project per work item (for example from the repository in the technical notes, a mapping in the settings, or an area path), so a Story's task runs in its service's project and worktree. Found during A11 phase 2. **Done (20 November 2026):** a work item names its repository with a `repo:<name>` tag, set through `repository` on `ado_update_technical_notes` (the architect, per Story) or `ado_create_work_item` (Tiamat on the Documentation: Grimoire), checked against ADO and copied to items created under it. A new linked task goes in the Paperclip project with a workspace on that repository (repo URL ending `/_git/<name>`; the primary workspace wins), else the project named like the repository, else its parent task's project as before; when the item names a repository no project has, the task says so. Only new tasks are placed; an existing task is not moved. `src/projects/index.ts`. Setup: one Paperclip project per repository, with a workspace on it (for the test team, a SimpleRepo project).

Dropped (19 November 2026): a dedicated ADO field for review and QA instructions (only the smoke test needs them; A10 covers it), and moving the test agents to a stronger model (the test project's output quality does not matter).

Open questions: which ADO projects first; the exact "ready for an agent" signal; whether agents should be allowed to create ADO items through the plugin or only through MCP.

## B. Logging and debugging in the UI

Evidence from the pilot: getting at run transcripts means running `scripts/pull-logs.ps1` over the VPN with an SSH passphrase twice, then `analyze-logs.py` to see whether sessions resumed and how big the context was. That is the first thing to fold into the product.

**B1. Run explorer (P1, M).** One page listing runs across agents, filterable by agent, task, status and time range, with duration, cost, whether the session resumed or started fresh, context size at start and end, and exit reason. Equivalent of `analyze-logs.py`, in the UI. First step: check what the existing agent page run history already shows and extend it into a company-wide view.

**B2. Transcript viewer with redaction (P1, M).** Render a run's NDJSON transcript: assistant text, tool calls with collapsible arguments and results, search within the run, jump to the first error, download. **Redact secrets on display and download**: the pilot notes agents can print secrets into logs, so this is a safety item, not polish.

**B3. Context and session health (P2, S).** Chart context growth per session; flag runs that unexpectedly started cold, and runs nearing a context limit. Direct input for tuning `maxTurnsPerRun` and when to reset sessions.

**B4. "Why did this run start?" (P2, M).** For each run show the wake reason and chain (comment, status change, schedule, parent task, manual) using run events and the activity log. Answers "why is this agent busy?".

**B5. Failure inbox (P2, M).** Failed, timed-out and stuck runs in one list, each classified by likely cause: Claude sign-in expired, MCP server unreachable, ADO PAT expired, budget stop, max turns, blocked on a guardrail. The classes come from the pilot's troubleshooting table. One-click retry where safe.

**B6. Per-task timeline (P3, M).** One chronological view per task: runs, comments, status changes, and (after A5) ADO and PR events.

**B7. Spike: OTLP to a self-hosted viewer (P3, S).** Paperclip can already export Claude Code traces to a custom OTLP endpoint. Try a small collector plus viewer on the VM or locally and see whether it covers B3/B4 cheaply before building more UI.

**B8. Log retention and disk guardrails (P2, S).** Run logs grow on a 64 GB disk. Add retention (age or size), a size indicator in settings, and a warning before the disk fills.

## C. Agent memory

Constraints we already have: instructions live in one place per agent (the Paperclip bundle in `paperclip/<name>/`), shared procedures are skills, and documents live in the Grimoire repo. Memory must not create a second source of truth for any of them. Rule of thumb: stable rules go in `AGENTS.md`; learned, situational facts go in memory; the retro step (C5) promotes durable lessons and removes them from memory.

**C1. Decided: start with the LLM Wiki plugin (done).** It is already in the repo, keeps plain markdown on disk, and is close to what the Grimoire repo already is for documents. See the plugin notes at the end of this file. The planned memory service from the 2026-03 design stays on the shelf unless the wiki proves too limited.

**C2. Install and configure the plugin (P2, M).** Install it on the local Docker instance first, then the VM; point its wiki folder at the Grimoire repo and adjust Grimoire's layout where needed; leave event ingestion off at first; add the dummy-project work as the first thing it distils. Check that the plugin's own alpha gaps (live install and agent invocation) work in our build.

**C3. Review gate for wiki writes (P2, M).** Keep the wiki folder in git so every change is a reviewable diff, and have the maintainer's changes land through a branch and approval rather than silently. Reason: anything an agent writes today is read by agents tomorrow, so an unreviewed write is a way for a bad instruction (including text smuggled in through a ticket or web page) to persist. The plugin already offers propose-patch tools and stale-hash protection; the spike confirms how far that goes.

**C4. Provenance per run (P2, M).** Show, on each run, which wiki pages the agent read or wrote. Pairs with the transcript viewer (B2) and answers "why did the agent do that?".

**C5. Retro loop (P3, M).** A scheduled job reads recent blocked or failed tasks and review comments, and proposes edits to agent bundles and skills as pull requests. Memory that proves useful across agents is promoted into instructions and removed from the wiki.

**C6. Measure it (P3, S).** Before and after: tokens per task, rework cycles, review comments per PR, blocked rate. See `doc/plans/2026-10-03-connection-instructions-and-memory-evals.md` for existing evaluation thinking.

## D. Efficiency and agent operations

Mostly drawn from what the pilot showed in `../PAPERCLIP-PILOT.md` (sections 3.9 and 4).

**D1. Fix session resume (P1, investigation S, fix M).** In the pilot, 10 of 11 Tiamat runs and one Orochi run discarded the previous session and started fresh ("session does not match the current agent/cwd/mode/runtime identity"), so every wake rebuilt 52,000 to 60,000 tokens of context. The decoded session name matched on agent, working directory and mode, and the skills folder hash was ruled out, so the mismatch is in the runtime part. The check is in `packages/adapter-utils/src/acpx-engine/execute.ts` (around line 4600), with existing tests in `execute-identity.test.ts` and `session-reuse-store.test.ts`. Step 1: reproduce and find the cause. Step 2: fix. Also verify that an answer or comment on a blocked task wakes the *same* session.
*Done when:* a second wake on the same task shows a resumed session in the run explorer (B1) and context grows incrementally instead of resetting.

**D2. Shrink the cold-start context (P1, M).** A fresh run uses about 42,000 to 44,000 tokens before any work, and a wording-only change on a new session ended near 121,000. First, measure what makes up the cold start (system prompt, agent instructions, skill list, tool definitions, wake context); I have not measured it. Then cut the biggest parts: role-specific tool sets from A8, shorter always-on instructions with detail moved into on-demand skills, and trimming what is sent on wake. Uses the context charts from B3.

**D3. Agent instructions: git sync, self-update, download/upload (P1, M).**
- *Git sync:* a command or scheduled job applies `paperclip/<name>/` and `skills/` from the repo to the agents through the existing APIs (the Advanced YAML covers instructions and skills), and reports drift both ways. Removes the copy-paste step.
- *Download/upload:* per-agent export and import of the instruction bundle (and optionally the full configuration), from the UI. First check what the Instructions editor and Advanced tab already offer.
- *Self-update:* agents can already edit their own managed files directly. Change this so instruction changes can only happen as a pull request into the repo, with the run and agent recorded in the PR. Since the current editor keeps no revision history, git is the history.
*Decided:* git is the source of truth. An agent never changes its own live files directly; it proposes the change as a pull request into the repo, you merge it, and the sync job applies the merged version to the agent. Live files that differ from git are drift, reported and corrected from git. Design points for the build: block or ignore direct self-edits to instruction files (agents may still keep personal notes in their other files), define which repo and branch the PRs target, and decide how an agent's PR to its own instructions is reviewed (you merge; no agent approves its own change).

**D4. Notifications when an agent needs you (P2, M).** Events: an agent blocked on a question, an approval requested, a failed run, a budget stop, a PR waiting for you to merge, and the ADO states that wait for Josh (Epic Plan Review, Feature Ready For Approval, Story Ready To Merge, Document In Review, anything Blocked). Josh prefers in-app and Windows notifications over Teams or Slack (19 November 2026). **ADO part done (19 November 2026):** the plugin's toolbar button lists the ADO items waiting for Josh and shows a Windows notification for each new one while a Paperclip tab is open (`doc/plans/2026-11-14-ado-integration.md`, "D4"). **Paperclip's own events done (20 November 2026):** with browser notifications turned on in Profile settings, a background Paperclip tab shows one for a new approval (including a budget hard stop, which asks for one), a new failed run, or a task newly waiting for you in the inbox (fork patch 17, `ui/src/lib/browser-notifications.ts`). Open: notifications with no tab open (web push; skipped for now, 20 November 2026). In-app: badge and entries in the existing inbox. Windows notifications: spike the options (browser notifications, which need permission and an open tab; an installable web app; or forwarding to Teams/email). The UI already runs over HTTPS behind Caddy, which browser notifications require.

**D5. Per-agent skills, connectors and environment variables (P2, discovery).** The UI manages all three (and the Advanced YAML covers them) but day-to-day management is painful. We will go through each one when we reach it and fix it for per-agent use. Starting list of known pain from the pilot: secret reference syntax and the picker are unclear; where MCP servers are configured and whether they are found from worktrees (one server showed "Pending approval" but worked); skills need re-importing to stay in sync; no overview of which agent has which skill, connector or variable. Output of this item is a written pain-point list; fixes become their own items.

**D6. Automated checks before the review agent (P2, M).** Build, tests and analyzers run as plain code on the branch, with results attached to the task and PR. The review agent only sees changes that pass, which saves tokens and review loops. Needs the build tools available where the checks run.

**D7. Proper worktree provisioning (P2, M).** Isolated workspaces are experimental. Make them start from a fresh `origin/main` (fetch first), name branches `ai/<ado-id>-<short-name>`, make sure parent `CLAUDE.md` files are still seen, and clean up when the task closes. Needed before several builders run in parallel.

**D8. Docs publisher as a scheduled job (P2, M).** A plain job (no agent, no tokens) that converts merged Grimoire documents and publishes them to Confluence, including Mermaid diagrams, on merge to `main`. Open: whether Confluence accepts Markdown or needs its storage format, how Mermaid is rendered, and how the job maps to Grimoire's layout after C2.

**D9. Cost and usage visibility (P2, M-L).**
- Cost and tokens per run, task, agent and Feature, shown in the UI and written back to the ADO work item (with A4's roll-ups, the plugin can write a Feature's total when it completes). **Feature and Epic part done (20 November 2026):** when a Feature or Epic is Completed, the ADO plugin posts its cost on the work item and on its Paperclip task: everything recorded for its task and the tasks under it, by agent and by model, billed cost and the API-price estimate (`src/costs/index.ts`). It waits until no run under it is queued or running and the last finished a minute ago, because costs are recorded after a run's status. Needs fork patch 16 (cost breakdown by model for plugins).
- Even on the subscription, an API-price estimate per Feature, to judge whether the API or the subscription is cheaper. **Done for Features and Epics:** the rate card (USD per million tokens: input, cache read, output, per model) is `API_RATE_CARD` in `packages/shared/src/api-rate-card.ts`, checked 20 November 2026; update it there when prices change (the server prices usage with it, and the plugin reads the server's estimate). Cache writes are priced as plain input, so the estimate can be a little low. **Compared on the Costs page (20 November 2026):** each agent and model shows its cost at API prices where that differs from billed cost, and the overview compares the period's subscription usage at API prices with the monthly fees.
- Budget alerts before a hard stop (links to D4). **Done (20 November 2026):** a budget can count the API-price estimate (metric `api_estimate_cents`), so a $ budget, its 80% warning and its hard stop work on the subscription as if on the API. Set it beside the billed budget on an agent's Budgets tab or, for the organization, on the Costs page's Budgets tab. Reservations stay on billed cost. Usage still running is counted once its cost is recorded.
- Model routing rules: Sonnet by default, Opus only for architecture work or after repeated failures. **Escalation on failure done (20 November 2026):** each agent keeps its configured model; when a Story or Bug reaches the last round of review changes before Blocked, or its QA Tests have failed twice, the ADO plugin sets the plugin setting `escalationModel` (default `claude-opus-5-5`, empty turns it off) on the builder's task, so the builder's later turns on that Story run on it (`packages/plugins/plugin-ado/src/escalation/index.ts`, fork patch 17).
- Subscription breakdown: usage against the Claude subscription, by agent, task and day. Unknown how much of this is available. Run logs show context size, not billing, and the pilot never confirmed how subscription runs are reported. First step: find out what data exists (run logs, the CLI, the Claude usage page). If subscription limits are not exposed, estimate from tokens per run and compare against the Claude usage page by hand.

**D10. In-repo plugins ship with the code (P1, done).** Plugins that live in this repo are listed in `scripts/shipped-plugins.json` and are built, deployed, updated and rolled back with the server, on the VM (managed git install) and in Docker, with no manual install step. The server installs them at startup, adopts an existing hand-made install of the same plugin and approves their capabilities. Adding another (the LLM Wiki plugin for C2) is one line in that list plus a `files` field in its `package.json`. How it works: `doc/DEPLOYMENT-STEPS.md`, "How in-repo plugins ship".

## E. Chat

Goal: make agent chat behave like the chat you know from Claude, then let several agents join one conversation. Today one chat per agent per user is baked into the data model (see "What the code already gives us"), which shapes all three items.

**E1. Delete a chat (P2, S-M).** A delete action with confirmation in the chat list, removing the conversation, its messages and attachments. Points to settle: whether run logs and cost records for a deleted chat are kept (I suggest keeping cost records so usage reporting in D9 stays correct, minus the message content); how deletion interacts with the retained-history rules that already exist for some chat records (voice sessions are restricted); and removing it from the "recent chats" list the browser keeps.

**E2. Multiple chat sessions per agent (P2, M).** Remove the one-chat-per-agent-per-user limit: a "New chat" button, a list of sessions per agent in the sidebar ordered by recent activity, automatic titles from the first message, rename, and delete (E1). Needs a database migration (drop the unique index, add a way to tell sessions apart), a change from "chat with this agent" to "chat with this ID" in the routes and URLs, and updates to the recent-chat logic and the wake and recovery code that assume one conversation per agent. Existing chats become the first session of their agent.
*Done when:* you can start a second chat with the same agent, switch between them, and each keeps its own history and context.

**E3. Group chat with several agents (P3, L).** A conversation with you and several agents, like a group chat between people. Design spike first, because this is the hardest item here:
- *The task model gets in the way.* A chat is currently a task with exactly one assignee, enforced in the database, and the engineering rules in `AGENTS.md` (section 5) protect the single-assignee invariant. A group chat has several agents and no single owner. The spike should decide between a new chat model with a participants list (my lean, so chats stop pretending to be tasks) and keeping the task container with an exception for chats.
- *Who answers a message?* Options: only agents you @mention answer (cheap, predictable, my lean); every agent answers every message (usage multiplies with each participant); a lead agent decides who speaks. An "ask everyone" button can cover the occasional need.
- *Agents replying to each other.* Useful for back-and-forth, but can loop and burn usage. Needs a cap on agent-to-agent turns per message you send, and one Stop button that stops everyone.
- *Context and cost.* Each agent needs to see the shared conversation, and each keeps its own session, so context and usage grow with every participant. This is why D1, D2 and D9 come first, and why the chat should show usage per conversation and allow a participant limit.
- *Interface:* add and remove participants, avatars and per-agent "working" indicators, @mention picker.
*Done when:* you can add two agents to a chat, address one by @mention, see both answer in the same thread, and see what the conversation cost.

**E4. Turn a chat into an ADO work item or Grimoire document (P3, M).** A button on a chat (or on selected messages) that captures what was agreed and files it, so decisions made in conversation don't get lost.
- *Work item:* the agent drafts a title, description, acceptance criteria and suggested type (Epic, Feature, Story, Bug) and parent from the conversation. You review and edit the draft, then confirm. Creation goes through the ADO plugin (A8), never directly, and the new item links back to the chat and shows in the chat.
- *Document:* same flow, but it follows the existing document rule: a Documentation work item, a branch, and a pull request into the Grimoire repo for you to merge (see C2 for the Grimoire layout).
- *Nothing is written until you confirm.* The draft step costs one short agent turn; there is no hidden write.
- Works the same in a group chat (E3), drawing on what all participants said.
Open: which ADO project and parent a chat-created item defaults to, and whether the draft uses the chat's agent or a fixed cheap one.
*Done when:* from a finished chat you can create a linked ADO item or a Grimoire pull request in one confirmation.

## Decisions

Made:

1. **ADO writes go through our plugin** (A4, A7, A8), even if the plugin only wraps the MCP server underneath.
2. **Inbound ADO events use ADO service hooks sending to an Azure Service Bus queue (Basic tier)**, and the plugin keeps a listener on it over an outbound connection, so nothing polls and nothing is exposed publicly. Missed events are picked up by a catch-up on startup and from a Sync now button, not on a timer. Details and cost in `doc/plans/2026-11-14-ado-integration.md`.
3. **First slice is a dummy ADO project with two throwaway agents**, not Tiamat (see "First slice").
4. **Memory starts with the LLM Wiki plugin** (C1).
5. **Agent instructions: git is the source of truth; agents change their own instructions only by submitting pull requests** (D3).
6. **Added from the ideas list:** D1, D2, D3 (with self-update and download/upload), D4 (in-app plus Windows), D5 (as discovery), D6, D7, D8, D9 (with subscription breakdown). **Declined:** automated regression tests for agent behaviour; features are tested as they are built.

Cost: Service Bus Basic is about $0.05 per million operations (checked November 2026; confirm in the Azure pricing calculator). Azure Relay and Event Grid push were rejected because both need a public endpoint.

Still open:

1. ~~Where the wiki lives~~ Decided: the plugin points directly at the Grimoire repo, and Grimoire's layout may change to suit it. Work for C2: check how the plugin's `raw/` and `wiki/` layout maps onto Grimoire's current layout and front-matter, and agree the changes.
2. ~~Which ADO project name and repo for the slice~~ Decided: project `AI Testing`, repo `SimpleRepo` (https://dev.azure.com/ChimeraStudioSoftware/AI%20Testing/_git/SimpleRepo). The event queue lives in the personal sandbox subscription next to the VM.

## First slice

Goal: prove the loop end to end with almost no token spend, before any real work flows through it.

- **ADO:** a throwaway project using the same process as the studio (Agile: Epic > Feature > User Story > Task), with a small test repo and the service-account PAT.
- **Agents:** two throwaway agents on the cheap model, created only for this slice, with placeholder names (Maple and Juniper; rename freely). Maple (doer) does a trivial task, such as adding a line to a text file on a branch and opening a PR. Juniper (checker) reviews that PR and comments. Neither does real work. The director (Tiamat) is not involved; you create the work item in ADO yourself.
- **Flow to prove:** work item created in ADO, event arrives through the queue, Paperclip task is created and linked (A1, A2, A3), agent acts only through plugin tools (A8), states update in ADO (A4), PR shows on the task (A5), and the whole run is visible in the UI (B1, B2).
- **Done when:** one story goes from New to Done with no manual bookkeeping, and the run transcripts can be read in the UI without pulling files from the VM.

## Notes: the LLM Wiki plugin (relevant to C1)

A bundled plugin (`packages/plugins/plugin-llm-wiki`, alpha) that keeps a markdown wiki on a local folder: `raw/` for captured sources and `wiki/` for pages written and maintained by a managed "Wiki Maintainer" agent, with an index, a log, backlinks, and per-project pages (index, standup, decisions, history). Agents get tools to search, read and write pages. It can optionally ingest Paperclip issues, comments and documents (off by default) and distil them into the project pages. As memory it is a fit for team and project knowledge, not for each agent's private lessons, and it costs tokens because the maintainer agent runs. Its own README lists remaining alpha gaps, including live server smoke tests.
