/**
 * Declarations of the ADO agent tools. Shared by the manifest (what the host
 * shows agents) and the worker (what it registers), so they cannot drift.
 */
import type { PluginToolDeclaration } from "@paperclipai/plugin-sdk";

export const TOOL_NAMES = {
  getWorkItem: "ado_get_work_item",
  addComment: "ado_post_comment",
  setState: "ado_update_state",
  linkPullRequest: "ado_create_pr_link",
  createChildWorkItem: "ado_create_child_work_item",
} as const;

/**
 * Names matter to the host: its tool gateway rates a tool "write" only if a
 * name segment is a write verb (create, update, post, ...; inferToolRisk in
 * server/src/services/tool-gateway.ts), and reads may run without approval.
 * Every tool that writes must therefore carry such a verb.
 */
export type AdoToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

const workItemId = {
  type: "integer",
  minimum: 1,
  description:
    "Azure DevOps work item ID, for example 1234. Optional: if omitted, the work item linked to the task you are working on is used.",
};

export const TOOL_DECLARATIONS: PluginToolDeclaration[] = [
  {
    name: TOOL_NAMES.getWorkItem,
    displayName: "ADO: get work item",
    description:
      "Read an Azure DevOps work item: type, title, state, assignee, area and iteration, description, acceptance criteria, " +
      "its parent, children, related items and linked pull requests, and the most recent comments. " +
      "Use this before changing a work item, and again after a write fails because the item changed.",
    parametersSchema: {
      type: "object",
      properties: {
        workItemId,
        commentCount: {
          type: "integer",
          minimum: 0,
          maximum: 20,
          default: 5,
          description: "How many of the most recent comments to include (0 to 20, default 5).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.addComment,
    displayName: "ADO: add comment",
    description:
      "Add a comment to an Azure DevOps work item. Write plain text; line breaks are kept and your agent name is added in front automatically, " +
      "so do not sign the comment yourself.",
    parametersSchema: {
      type: "object",
      properties: {
        workItemId,
        text: { type: "string", minLength: 1, maxLength: 20000, description: "The comment, as plain text." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.setState,
    displayName: "ADO: set state",
    description:
      "Move an Azure DevOps work item to another state, for example from New to Active or from Active to Resolved. " +
      "The state must be one of the states of the item's type; if it is not, the valid states are listed in the reply. " +
      "Optionally explain the change in `comment`, which is recorded in the item's history.",
    parametersSchema: {
      type: "object",
      properties: {
        workItemId,
        state: { type: "string", minLength: 1, description: "The target state name, exactly as ADO names it, for example \"Active\"." },
        comment: { type: "string", maxLength: 5000, description: "Optional reason for the change, as plain text." },
      },
      required: ["state"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.linkPullRequest,
    displayName: "ADO: link pull request",
    description:
      "Link an Azure DevOps pull request to a work item, so the work item shows the PR under Development. " +
      "Give the repository name (or ID) and the pull request number. Linking the same PR twice does nothing.",
    parametersSchema: {
      type: "object",
      properties: {
        workItemId,
        repository: { type: "string", minLength: 1, description: "Repository name or ID in the ADO project, for example \"SimpleRepo\"." },
        pullRequestId: { type: "integer", minimum: 1, description: "The pull request number, for example 42." },
      },
      required: ["repository", "pullRequestId"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.createChildWorkItem,
    displayName: "ADO: create child work item",
    description:
      "Create a new Azure DevOps work item under a parent, for example a Task under a User Story or a User Story under a Feature. " +
      "The new item gets the parent's area and iteration. Write the description as plain text. " +
      "Which types you may create depends on your role; the reply says so if a type is not allowed.",
    parametersSchema: {
      type: "object",
      properties: {
        parentId: {
          type: "integer",
          minimum: 1,
          description: "ID of the parent work item. Optional: if omitted, the work item linked to your current task is the parent.",
        },
        type: {
          type: "string",
          minLength: 1,
          description: "Work item type, for example \"Task\", \"Bug\", \"User Story\" or \"Feature\".",
        },
        title: { type: "string", minLength: 1, maxLength: 255, description: "Title of the new work item." },
        description: { type: "string", maxLength: 20000, description: "Optional description, as plain text." },
      },
      required: ["type", "title"],
      additionalProperties: false,
    },
  },
];
