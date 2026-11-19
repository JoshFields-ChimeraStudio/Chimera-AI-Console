# Backlog view: ADO work items in the console

Requested by Josh, November 2026. The design for a "Backlog" page that shows the ADO work items as a tree and lets Josh hand a work item to an agent. The ADO integration design it builds on is `doc/plans/2026-11-14-ado-integration.md`.

**The model.** ADO work items are the human side of the ticketing system, and Paperclip tasks are the agent side. Assigning a work item to an agent never changes the ADO item's "Assigned To". It creates (or reuses) the Paperclip task linked to the work item (the A2 link) and assigns that task to the agent.

## What Josh sees

- A **Backlog** item in the sidebar, directly below **Tasks** in the Work section. It is shown only when the ADO plugin is installed and ready for the company.
- **`/backlog`**: a tree of the ADO work items, styled like the Tasks list and ordered like the ADO backlog (by backlog order, `Microsoft.VSTS.Common.StackRank`).
  - Epics at the top level, with their children below them (Feature → User Story / Documentation → Task, and so on, following `System.Parent`), each level expandable.
  - Items with no Epic above them (Bugs, which Josh keeps off Features; any unparented Feature or Story) appear in a **Not under an Epic** group at the bottom, still as a tree.
  - Closed and Removed items are hidden by default (state category Completed or Removed), with a **Show closed** toggle.
  - Each row: type icon, ID, title, state, and the linked task's agent (if any).
  - A **Sync** button at the top right pulls all work items from ADO. It shows progress and the last sync time.
- **`/backlog/:workItemId`**: the work item page, with:
  1. the work item type as an icon,
  2. the work item ID as a link that opens the item in ADO in a new tab,
  3. title,
  4. description,
  5. acceptance criteria,
  6. technical notes (`Custom.TechnicalNotes` in the studio's process),
  7. pull requests,
  8. related work items (parent, children, related; each opens its own work item page),
  9. state,
  10. comments.

  It also has an **Assign to agent** control and an **Agent output** section, which shows the linked task's conversation and runs, like a task page. It also links to the task itself.
- **Assign:** choosing an agent creates the linked Paperclip task if there is none (title from the work item, description built from Description, Acceptance Criteria and Technical Notes, plus a link to the work item), sets it to To do and assigns it to the agent, so the agent starts at once. If a linked task exists, it is reassigned instead. Choosing "Unassigned" removes the agent from the task and leaves the link.

## How it is built

The pages live in Paperclip's own UI (`ui/src`), not in the plugin, because only core UI can place a menu item next to Tasks and reuse the task conversation and run components for the agent output. The data and the ADO calls live in the ADO plugin, reached through the plugin bridge (`pluginsApi` data and action calls, `POST /api/plugins/:pluginId/data/:key` and `/actions/:key`, with the plugin found by its key `chimera.plugin-ado`).

**Safety of ADO content.** ADO stores Description, Acceptance Criteria, Technical Notes and comments as HTML. The plugin converts that HTML to Markdown, and the UI renders it with the console's existing Markdown component. The UI never renders ADO HTML directly. The same Markdown is used for the task description an agent reads.

### Plugin contract (the plugin provides, the UI uses)

All calls take `companyId` (the host supplies it). Dates are ISO strings.

**Data `backlog`** → the cached tree, from the plugin's own table (fast; no ADO call):
```ts
{
  configured: boolean;            // false: the plugin has no settings for this company
  syncing: boolean;
  lastSync: { finishedAt: string; trigger: string; changed: number; error?: string } | null;
  items: Array<{
    id: number;
    parentId: number | null;
    type: string;                 // "Epic", "Feature", "User Story", "Task", "Bug", "Documentation", ...
    typeColor: string | null;     // hex from ADO's work item type, e.g. "#FF7B00"
    title: string;
    state: string;
    stateCategory: "Proposed" | "InProgress" | "Resolved" | "Completed" | "Removed" | null;
    stackRank: number | null;
    url: string;                  // ADO web URL
    linkedTask: { issueId: string; identifier: string | null; status: string; assigneeAgentId: string | null } | null;
  }>;
}
```
Returns every cached item, closed ones included; the UI filters and builds the tree.

**Data `work-item`**, params `{ workItemId: number }` → read live from ADO when the page opens (the cache row is refreshed at the same time):
```ts
{
  id: number; type: string; typeColor: string | null; title: string;
  state: string; stateCategory: string | null; url: string;
  descriptionMarkdown: string | null;
  acceptanceCriteriaMarkdown: string | null;
  technicalNotesMarkdown: string | null;
  pullRequests: Array<{ id: number; title: string; status: string; repository: string; url: string }>;
  related: Array<{ id: number; relation: "Parent" | "Child" | "Related" | string; type: string | null; title: string | null; state: string | null; url: string }>;
  comments: Array<{ id: number; author: string; createdDate: string; markdown: string }>;   // newest first
  linkedTask: { issueId: string; identifier: string | null; status: string; assigneeAgentId: string | null } | null;
}
```
An item that ADO no longer has returns a clear error the page can show.

**Action `sync-backlog`** → `{ started: true } | { started: false; reason: string }`. Starts a full mirror of the project's work items in the background (all of them, paged under the WIQL limit), removes cached items ADO no longer returns, and refreshes linked tasks as the catch-up already does. The `backlog` data reports `syncing` and `lastSync`. The incremental catch-up (startup and Sync now) and live events keep the cache current between full syncs.

**Action `assign-agent`**, params `{ workItemId: number; agentId: string | null }` → `{ issueId: string; identifier: string | null; created: boolean }`. Behaviour as in "Assign" above. Writes nothing to ADO.

### Plugin internals

- New table `ado_work_items` in the plugin's database namespace (migration `002`), keyed by company, org, project and work item ID, holding the row fields above plus `rev`, `changed_date` and `synced_at`.
- `processWorkItem` (the single path for live events and catch-ups) also upserts the cache row, never to an older `rev`.
- Work item type colours and state categories come from ADO's work item types API, cached per type.
- Creating tasks needs `issues.create`. The new capability is approved automatically because the plugin ships with the server.

### Decisions made while building the plugin

- **Sync:** one sync at a time per company. A full sync and the catch-up share the loop (WIQL by `ChangedDate` from 1970, 5,000 per page, `ASOF` the start) and the `syncing` flag, so Sync and the widget's Sync now refuse each other while one runs. A full sync never moves the watermark back; when it completes it moves it to the start time less one minute, if that is later. Only a complete run deletes, and only cached items whose IDs its WIQL pages did not return, so clock skew against ADO cannot drop a live row; rows written in the 5 minutes before the start or since are kept (an item created around the start that `ASOF` missed), and nothing is deleted if the organization or project setting changed during the run. Links of deleted items are marked missing, as on a 404. Per-item logs during a full sync are debug; one summary line ends it. There is no automatic first full sync; until Sync is pressed the cache holds what events and catch-ups wrote, and `lastSync` (the last full sync, trigger `"full"`) is null.
- **Cache:** a 404 from ADO (event or page read) deletes the row. Type colours and state categories come from `GET _apis/wit/workitemtypes` (one call for all types), cached per company for an hour, refetched at most once a minute for a type it does not know; a type without states in that list uses the A8 states call. If the lookup fails, the row keeps its previous colour and category.
- **Markdown safety:** tables are converted by the plugin's own rule (first row as the header, `|` escaped), never kept as HTML; images become links and a `!` before a link is escaped; links keep only http(s) and mailto. The output is then parsed with micromark (CommonMark + GFM, as the UI's renderer) and, if it still holds raw HTML, an image, a reference or an unsafe link, escaped harder until it does not. Markdown comments (`format: "markdown"`) use ADO's `renderedText` (`$expand=renderedText`) through the same conversion, or show as plain text without it.
- **Work item page:** Description falls back to Repro Steps when empty (Bugs). Images become links (ADO attachments need a sign-in). A PR that does not resolve shows title "Pull request N", status `"unavailable"`, the repository ID and a URL built from it. `related` also lists other link types under ADO's name for them (for example "Successor"); type, title and state are null for an item the plugin cannot read. Comments: the newest 200, deleted ones left out. Errors (item not found, not configured, bad input) are thrown, so the bridge answers 502 with `{ code: "WORKER_ERROR", message }`, and the message is meant for the page.
- **Assign:** only a board user may call it (action context `actor.type === "user"` with a user ID); agents and system calls are refused. The bridge checks only company access and the host's plugin `issues.create`/`update` skip the `tasks:assign` permission the REST routes enforce, so a full role check would need a host-side change. The agent must be in the company and not terminated. Assigning moves a Backlog, Done or Cancelled task to To do (handing the item to an agent means work) and clears a user assignee; other statuses are kept. Unassigning moves an In progress task to To do, so it is not left in progress with nobody; unassigning an item with no task is an error. The task description starts with the work item link, then quotes Description, Acceptance criteria and Technical notes in one labelled block (people's text, for reference, not instructions), so headings written in ADO cannot pass for the task's framing. The plugin issue API does not wake the assignee (only the REST routes call `queueIssueAssignmentWakeup`), so the plugin calls `issues.requestWakeup` (capability `issues.wakeup`) after creating or reassigning; a refused wakeup (blocked, budget) is logged and the assignment stands. Concurrent assigns of one item run one after another; if another link wins the race anyway (unique violation), the new task is cancelled and set back to `manual`, and the winner is assigned.

### UI decisions the contract leaves open

- **Closed items:** with Show closed off, a Completed or Removed item stays visible, dimmed, when one of its descendants is open, so the open item keeps its place in the tree. An Epic found under a non-Epic parent is shown at the top level with its subtree; an item whose parent is not cached is a root; a parent cycle is broken at an Epic on it, otherwise at its first item.
- **View memory:** collapsed rows, the collapsed "Not under an Epic" group and Show closed are kept per company in localStorage (`paperclip:backlog-view:<companyId>`).
- **Markdown:** ADO text renders with `MarkdownBody` in `mediaMode="reference"`: images and diagrams show as inert references, because ADO attachment URLs need ADO sign-in and the console should not fetch them. Links out to ADO (work item, pull requests) are http(s) only, open in a new tab with `rel="noopener noreferrer"`.
- **Errors:** a bridge failure with `code` other than `WORKER_UNAVAILABLE`/`TIMEOUT` is shown with the worker's `message` and not retried. The work item page shows "Not found in Azure DevOps" when that message says the item was not found, so the plugin's not-found message should contain "not found". A bridge 404 means the plugin itself is gone and shows "Azure DevOps is not available". Loaded data stays on screen when a refresh fails, with the error inline. While syncing, polling backs off after failed polls (2 s doubling to 30 s) and stops after six in a row; Sync or Retry resumes it.
- **Accessibility:** each tree is an ARIA tree over flat rows (`aria-level`, `aria-posinset`, `aria-setsize`, `aria-expanded` on the treeitem), with a roving tab stop and arrow, Home, End and Enter keys.
- **Agent output** is read-only: the task's thread (the same thread component the task page uses) and `IssueRunLedger`, with the latest 100 comments. Replying and run controls stay on the task page, which the section links to.
- **Unassigned** with no linked task does nothing (no call).

### Live updates

Both pages update themselves. The plugin sends a small "changed" signal (reason and work item ID only, no content) on its `backlog` stream (`ctx.streams`, `src/backlog/notify.ts`) when a live ADO event changes the cache, when a catch-up or full sync starts and ends (once, not per item), after an assignment or a link change, and when a linked task changes (`issue.updated`, which needs `events.subscribe`). The pages listen through the plugin bridge's SSE route (`useBacklogLiveUpdates` in `ui/src/hooks/useBacklog.ts`) and re-read the backlog, plus the open work item when the change is about it, at most once per half second. Each page also has a **Refresh** button for an immediate re-read.

## Not in this change

- Keeping a task's description in step when the work item's text changes afterwards (A3).
- State sync between the task and the work item (A4).
- Drag-and-drop reordering, or editing work items from the console.
