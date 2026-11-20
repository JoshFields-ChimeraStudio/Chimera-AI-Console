import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { TOOL_DECLARATIONS } from "./tools/definitions.js";
import { ROLES } from "./tools/roles.js";

export const PLUGIN_ID = "chimera.plugin-ado";

export const DATA_KEYS = { status: "status" } as const;
export const ACTION_KEYS = { syncNow: "sync-now" } as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Azure DevOps",
  description:
    "Listens for Azure DevOps service hook events on an Azure Service Bus queue and keeps tasks in step with ADO work items.",
  author: "Chimera Studio",
  categories: ["connector"],
  // A1 skeleton, A2 links (issues.*, database.namespace.*, ui.action.register),
  // A8 agent tools (agent.tools.register, agents.read for role names, activity log) and
  // the Backlog view (issues.create for the linked task, issues.wakeup because the plugin
  // issue API does not wake the assignee by itself, events.subscribe so the page hears of linked
  // task changes; live page updates use the plugin stream, which needs no capability), and the
  // agents' assignment tool (issue.comments.create for its optional note on the linked task).
  capabilities: [
    "companies.read",
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register",
    "ui.detailTab.register",
    "agent.tools.register",
    "agents.read",
    "activity.log.write",
    "issues.read",
    "issues.orchestration.read",
    "projects.read",
    "issues.update",
    "issues.create",
    "issues.wakeup",
    "issue.comments.create",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "ui.action.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  // Schema plugin_ado_3dc5cc6a90 (derived by the host from the id and this slug); see migrations/.
  database: {
    namespaceSlug: "ado",
    migrationsDir: "migrations",
    coreReadTables: ["issues"],
  },
  // Secret fields have no "type": the settings form stores a { type: "secret_ref", secretId } object.
  instanceConfigSchema: {
    type: "object",
    properties: {
      orgUrl: {
        type: "string",
        title: "Organization URL",
        description: "For example https://dev.azure.com/ChimeraStudioSoftware",
      },
      project: {
        type: "string",
        title: "Project",
        description: "The ADO project to sync, for example AI Testing",
      },
      pat: {
        format: "secret-ref",
        title: "Personal access token",
        description: "Service account PAT with Work Items (Read & write) and Code (Read & write)",
      },
      serviceBusConnection: {
        format: "secret-ref",
        title: "Service Bus connection string (listen only)",
        description: "Connection string of a shared access policy with Listen rights only, on the namespace or the queue",
      },
      queueName: {
        type: "string",
        title: "Service Bus queue",
        default: "ado-events",
      },
      serviceAccountName: {
        type: "string",
        title: "Service account display name",
        description: "Events caused by this account are ignored so the plugin never reacts to its own writes",
      },
      smokeTestAgent: {
        type: "string",
        title: "Smoke-test agent",
        description:
          "The agent the smoke-test Epic is assigned to (the test team's planner, for example Rowan). Leave empty to turn the smoke-test widget's buttons off, for example on the real team's project.",
      },
      builderRoutes: {
        type: "array",
        title: "Builder routes (automatic assignment)",
        description:
          "Which agents build which kind of Story, and how many open Stories and Bugs each may hold. When Josh sets a Feature Ready For Work, the plugin assigns " +
          "its Stories tagged builder:<role> (by the planner) to the agent of that role holding the fewest, up to the limit, and the Reviews, QA Tests and Tasks " +
          "tagged for:<agent> to that agent; a Story waits for a free builder or for the items it depends on. Leave empty to have the director assign everything.",
        items: {
          type: "object",
          properties: {
            role: { type: "string", title: "Builder role", description: "As the planner tags Stories, for example backend, web, infra" },
            agents: { type: "string", title: "Agents", description: "Agent names, comma-separated, first preferred on a tie, for example Ouroboros, Hydra" },
            wipLimit: { type: "integer", title: "Open Stories per agent", minimum: 1, default: 1 },
          },
          required: ["role", "agents"],
        },
        default: [],
      },
      escalationModel: {
        type: "string",
        title: "Escalation model",
        description:
          "When a Story or Bug reaches its last round of review changes, or its QA Tests have failed twice, its builder's later turns on that Story run on this model " +
          "(for example claude-opus-5-5). Other tasks and agents keep their model. Leave empty to turn this off.",
        default: "claude-opus-5-5",
      },
      agentRoles: {
        type: "array",
        title: "Agent roles for ADO tools",
        description:
          "Each agent's ADO role: director (Epic, Documentation, assigning approved work, roll-ups), planner (the plan and the work item tree), architect (technical notes, Ready For Approval), " +
          "builder (its own Stories, Bugs, Documents, Tasks and Defects), reviewer (its own Review items), qa (its own QA Test items and the Defects it finds), readonly (read only). " +
          "The agents read the full rules with the ado_get_workflow tool. " +
          "Agents not listed are readonly. To hand a name to a different agent, remove the entry, save, and add it again.",
        items: {
          type: "object",
          properties: {
            agent: { type: "string", title: "Agent name", description: "As shown in Paperclip, for example Tiamat" },
            role: { type: "string", title: "Role", enum: [...ROLES], default: "readonly" },
            agentId: {
              type: "string",
              title: "Agent ID (optional)",
              description:
                "Pins the entry to one agent. Without it, the first agent to use the name keeps the role; another agent later given the same name is readonly.",
            },
          },
          required: ["agent", "role"],
        },
        default: [],
      },
    },
    required: ["orgUrl", "project", "pat", "serviceBusConnection"],
  },
  tools: TOOL_DECLARATIONS,
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "ado-status",
        displayName: "Azure DevOps",
        exportName: "AdoStatusWidget",
      },
      {
        type: "dashboardWidget",
        id: "ado-smoke-test",
        displayName: "Azure DevOps smoke test",
        exportName: "AdoSmokeTest",
      },
      {
        type: "dashboardWidget",
        id: "ado-builder-queues",
        displayName: "Builder queues",
        exportName: "AdoBuilderQueues",
      },
      {
        type: "globalToolbarButton",
        id: "ado-needs-josh",
        displayName: "Azure DevOps: needs you",
        exportName: "AdoNeedsJosh",
      },
      {
        type: "detailTab",
        id: "ado-pull-request",
        displayName: "Pull request",
        exportName: "AdoPullRequestTab",
        entityTypes: ["issue"],
      },
      {
        type: "toolbarButton",
        id: "ado-task-link",
        displayName: "Azure DevOps link",
        exportName: "AdoTaskLink",
        entityTypes: ["issue"],
      },
    ],
  },
};

export default manifest;
