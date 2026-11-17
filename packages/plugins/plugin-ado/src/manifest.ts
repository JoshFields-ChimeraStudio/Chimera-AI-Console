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
  // A1 skeleton, A2 links (issues.*, database.namespace.*, ui.action.register) and
  // A8 agent tools (agent.tools.register, agents.read for role names, activity log).
  capabilities: [
    "companies.read",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register",
    "agent.tools.register",
    "agents.read",
    "activity.log.write",
    "issues.read",
    "issues.update",
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
      agentRoles: {
        type: "array",
        title: "Agent roles for ADO tools",
        description:
          "Which ADO tools each agent may use. readonly: read work items. builder: read, comment, set state, link PRs, create Task/Bug children. " +
          "reviewer: read, comment, set state. planner: everything, any child type. Agents not listed are readonly. To hand a name to a different agent, remove the entry, save, and add it again.",
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
