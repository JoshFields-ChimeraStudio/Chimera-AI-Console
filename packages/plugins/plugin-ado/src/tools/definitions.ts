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
  createWorkItem: "ado_create_work_item",
  /** "assign" is not one of the host's write verbs, so the name says "update". */
  assign: "ado_update_assignment",
  createPullRequest: "ado_create_pull_request",
  getPullRequestThreads: "ado_get_pr_threads",
  postPullRequestComment: "ado_post_pr_comment",
  getWorkflow: "ado_get_workflow",
} as const;

/**
 * Names matter to the host: its tool gateway rates a tool "write" only if a
 * name segment is a write verb (create, update, post, ...; inferToolRisk in
 * server/src/services/tool-gateway.ts), and reads may run without approval.
 * Every tool that writes must therefore carry such a verb.
 */
export type AdoToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

const repository = {
  type: "string",
  minLength: 1,
  description: "Repository name or ID in the ADO project, for example \"SimpleRepo\".",
};

const pullRequestId = { type: "integer", minimum: 1, description: "The pull request number, for example 42." };

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
      "Read an Azure DevOps work item: type, title, state, assignee, area and iteration, description, acceptance criteria, technical notes, " +
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
      "Move an Azure DevOps work item to another state, for example from In Progress to In Review. " +
      "The state must be one of the states of the item's type; if it is not, the valid states are listed in the reply. " +
      "Who may set which state (often only the item's assignee) is in ado_get_workflow; a refusal names the rule and who may. " +
      "Optionally explain the change in `comment`, which is recorded in the item's history.",
    parametersSchema: {
      type: "object",
      properties: {
        workItemId,
        state: { type: "string", minLength: 1, description: "The target state name, exactly as ADO names it, for example \"In Progress\"." },
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
    name: TOOL_NAMES.createWorkItem,
    displayName: "ADO: create work item",
    description:
      "Create a new Azure DevOps work item, for example a Task under a User Story, a Document under a Documentation item, or an Epic. " +
      "Every type needs a parent except Epic and Bug, which have none. A child gets the parent's area and iteration. " +
      "Write the description as plain text. Which types you may create, and under which parent type, is in ado_get_workflow; " +
      "the reply says so if a type is not allowed. Optionally assign the new item to an agent with `assignTo` (same rules as ado_update_assignment).",
    parametersSchema: {
      type: "object",
      properties: {
        parentId: {
          type: "integer",
          minimum: 1,
          description:
            "ID of the parent work item. Leave it out for an Epic or a Bug. For other types, if omitted, the work item linked to your current task is the parent.",
        },
        type: {
          type: "string",
          minLength: 1,
          description: "Work item type, for example \"Task\", \"User Story\", \"Feature\", \"Document\" or \"Epic\".",
        },
        title: { type: "string", minLength: 1, maxLength: 255, description: "Title of the new work item." },
        description: { type: "string", maxLength: 20000, description: "Optional description, as plain text." },
        acceptanceCriteria: {
          type: "string",
          maxLength: 20000,
          description:
            "Optional acceptance criteria, as plain text, one criterion per line. Only for types that have the field (Epic, Feature, User Story); for other types put them in the description.",
        },
        assignTo: { type: "string", minLength: 1, description: "Optional: name of the agent to assign the new item to." },
      },
      required: ["type", "title"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.assign,
    displayName: "ADO: assign work item",
    description:
      "Assign an Azure DevOps work item to an agent. This assigns the work item's linked Paperclip task (creating it if there is none), " +
      "puts it in To do and wakes the agent; ADO's Assigned To is not changed. " +
      "Director and planner may assign anything; others may hand off their own items, assign unassigned items under their own item, " +
      "or claim unassigned items for themselves (see ado_get_workflow). An optional note is posted on the task for the agent.",
    parametersSchema: {
      type: "object",
      properties: {
        workItemId,
        agent: { type: "string", minLength: 1, description: "Name of the agent to assign the work item to, for example \"Zhulong\"." },
        note: { type: "string", maxLength: 5000, description: "Optional note for the agent, posted as a comment on the linked task (not on ADO)." },
      },
      required: ["agent"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.createPullRequest,
    displayName: "ADO: create pull request",
    description:
      "Open a pull request from a branch you have pushed into the target branch (default main), linked to work items " +
      "(default: the work item of your current task). If an active pull request from that branch into that target already exists, " +
      "it is returned instead of a second one. Write the description as markdown; your agent name is added automatically. " +
      "You still push the branch yourself with git.",
    parametersSchema: {
      type: "object",
      properties: {
        repository,
        sourceBranch: { type: "string", minLength: 1, description: "The branch with your commits, for example \"ai/827-hello-world\"." },
        targetBranch: { type: "string", minLength: 1, default: "main", description: "The branch to merge into (default \"main\")." },
        title: { type: "string", minLength: 1, maxLength: 400, description: "Pull request title, for example \"#827 Add HelloWorld.md\"." },
        description: { type: "string", maxLength: 4000, description: "Optional description, as markdown." },
        workItemIds: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          minItems: 1,
          maxItems: 10,
          description: "Work items to link, for example [827] or [835, 827] for a Defect and its Story. Default: your current task's work item.",
        },
      },
      required: ["repository", "sourceBranch", "title"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.getPullRequestThreads,
    displayName: "ADO: get pull request threads",
    description:
      "Read a pull request's comment threads: each thread's ID, status (active, fixed, closed, ...), file and line, and its comments with their authors. " +
      "Also gives the pull request's title, status and branches. ADO's own system notes are left out unless includeSystem is true.",
    parametersSchema: {
      type: "object",
      properties: {
        repository: { ...repository, description: "Optional repository name or ID; the pull request is found in the project without it." },
        pullRequestId,
        includeSystem: { type: "boolean", default: false, description: "Include ADO's system notes (votes, pushes, policy)." },
      },
      required: ["pullRequestId"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.postPullRequestComment,
    displayName: "ADO: post pull request comment",
    description:
      "Comment on a pull request. With threadId, reply on that thread; without it, start a new thread, optionally on a file and line. " +
      "`status` sets the thread's status (active, fixed, wontFix, closed, byDesign, pending): for example start a finding as active, or mark a thread fixed when you reply that you fixed it. " +
      "Write markdown; your agent name is added in front automatically, so do not sign the comment.",
    parametersSchema: {
      type: "object",
      properties: {
        repository: { ...repository, description: "Optional repository name or ID; the pull request is found in the project without it." },
        pullRequestId,
        text: { type: "string", minLength: 1, maxLength: 20000, description: "The comment, as markdown." },
        threadId: { type: "integer", minimum: 1, description: "Reply on this thread. Leave out to start a new thread." },
        filePath: { type: "string", minLength: 1, description: "New thread only: the file the comment is about, for example \"/README.md\"." },
        line: { type: "integer", minimum: 1, description: "New thread only, with filePath: the line in the changed file." },
        status: {
          type: "string",
          enum: ["active", "fixed", "wontFix", "closed", "byDesign", "pending"],
          description: "Thread status to set. New threads default to active.",
        },
      },
      required: ["pullRequestId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.getWorkflow,
    displayName: "ADO: get workflow rules",
    description:
      "Read the ADO workflow rules the tools enforce: the roles, who may assign work items, who may create which type under which parent, " +
      "who may set which state on which type, and the allowed Document moves. Also says which role you have. Use this instead of a copy of the rules.",
    parametersSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];
