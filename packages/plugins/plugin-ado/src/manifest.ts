import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

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
  // Skeleton (A1) only. A2 adds issues.*, database.namespace.* and more ui.*; A8 adds agent.tools.register.
  capabilities: [
    "companies.read",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
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
    },
    required: ["orgUrl", "project", "pat", "serviceBusConnection"],
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "ado-status",
        displayName: "Azure DevOps",
        exportName: "AdoStatusWidget",
      },
    ],
  },
};

export default manifest;
