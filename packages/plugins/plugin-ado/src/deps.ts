/**
 * What the worker hands to feature modules (links for A2, agent tools for A8).
 * Keeps those modules independent of the listener and catch-up code in worker.ts.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AdoClient, WorkItemSummary } from "./ado/client.js";

export interface AdoSettings {
  orgUrl: string;
  project: string;
  serviceAccountName?: string;
}

export interface PluginDeps {
  ctx: PluginContext;
  /** An ADO client for the company, or an error if the plugin is not configured there. */
  adoClient(companyId: string): Promise<AdoClient>;
  /** The company's non-secret settings, or null if the plugin is not configured there. */
  settings(companyId: string): Promise<AdoSettings | null>;
  now(): number;
}

/** Called for every changed work item, from a live event or a catch-up. */
export type WorkItemChangedHandler = (companyId: string, item: WorkItemSummary, source: string) => Promise<void>;
