/**
 * The ADO plugin's Backlog contract, as the console UI consumes it.
 *
 * The single place these shapes live in the UI. The source of truth is the
 * "Plugin contract" section of `doc/plans/2026-11-17-backlog-view.md`; keep the
 * two in step. The plugin (`packages/plugins/plugin-ado`) provides the data and
 * actions; the UI reaches them through the plugin bridge (see `api/backlog.ts`).
 */

/** Plugin key of the ADO plugin (`manifest.id`). */
export const ADO_PLUGIN_KEY = "chimera.plugin-ado";

export const BACKLOG_DATA_KEYS = {
  backlog: "backlog",
  workItem: "work-item",
} as const;

export const BACKLOG_ACTION_KEYS = {
  syncBacklog: "sync-backlog",
  assignAgent: "assign-agent",
} as const;

export type BacklogStateCategory =
  | "Proposed"
  | "InProgress"
  | "Resolved"
  | "Completed"
  | "Removed";

/** The Paperclip task linked to a work item (the A2 link). */
export interface BacklogLinkedTask {
  issueId: string;
  identifier: string | null;
  status: string;
  assigneeAgentId: string | null;
}

export interface BacklogLastSync {
  finishedAt: string;
  trigger: string;
  changed: number;
  error?: string;
}

export interface BacklogItem {
  id: number;
  parentId: number | null;
  /** "Epic", "Feature", "User Story", "Task", "Bug", "Documentation", ... */
  type: string;
  /** Hex from ADO's work item type, e.g. "#FF7B00". */
  typeColor: string | null;
  title: string;
  state: string;
  stateCategory: BacklogStateCategory | null;
  stackRank: number | null;
  /** ADO web URL. */
  url: string;
  linkedTask: BacklogLinkedTask | null;
}

/** Data `backlog`: the cached tree, closed items included. */
export interface BacklogData {
  /** False: the plugin has no settings for this company. */
  configured: boolean;
  syncing: boolean;
  lastSync: BacklogLastSync | null;
  items: BacklogItem[];
}

export interface WorkItemPullRequest {
  id: number;
  title: string;
  status: string;
  repository: string;
  url: string;
}

export interface WorkItemRelated {
  id: number;
  relation: "Parent" | "Child" | "Related" | string;
  type: string | null;
  title: string | null;
  state: string | null;
  url: string;
}

export interface WorkItemComment {
  id: number;
  author: string;
  createdDate: string;
  markdown: string;
}

/** Data `work-item`, params `{ workItemId }`: read live from ADO. */
export interface WorkItemDetail {
  id: number;
  type: string;
  typeColor: string | null;
  title: string;
  state: string;
  stateCategory: string | null;
  url: string;
  descriptionMarkdown: string | null;
  acceptanceCriteriaMarkdown: string | null;
  technicalNotesMarkdown: string | null;
  pullRequests: WorkItemPullRequest[];
  related: WorkItemRelated[];
  /** Newest first. */
  comments: WorkItemComment[];
  linkedTask: BacklogLinkedTask | null;
}

export interface WorkItemParams {
  workItemId: number;
}

/** Action `sync-backlog`. */
export type SyncBacklogResult = { started: true } | { started: false; reason: string };

/** Action `assign-agent`. `agentId: null` unassigns the linked task. */
export interface AssignAgentParams {
  workItemId: number;
  agentId: string | null;
}

export interface AssignAgentResult {
  issueId: string;
  identifier: string | null;
  created: boolean;
}
