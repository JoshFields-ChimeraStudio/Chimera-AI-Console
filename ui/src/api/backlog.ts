/**
 * Typed client for the ADO plugin's Backlog contract, over the plugin bridge
 * (`pluginsApi.bridgeGetData` / `bridgePerformAction`). Shapes live in
 * `lib/backlog/contract.ts`; React Query hooks in `hooks/useBacklog.ts`.
 */

import {
  BACKLOG_ACTION_KEYS,
  BACKLOG_DATA_KEYS,
  type AssignAgentParams,
  type AssignAgentResult,
  type BacklogData,
  type SyncBacklogResult,
  type WorkItemDetail,
} from "../lib/backlog/contract";
import { ApiError } from "./client";
import { pluginsApi } from "./plugins";

/**
 * A failure the ADO plugin's worker reported through the bridge
 * (`{ code, message }` body, e.g. "Work item 123 was not found in ADO"). It
 * carries the worker's own message so the page shows it instead of generic
 * 502 copy, and no HTTP status, so the shared error copy treats it as a real
 * failure rather than an outage. Retrying cannot help, so hooks do not retry it.
 */
export class BacklogBridgeError extends Error {
  bridgeCode: string;
  constructor(message: string, bridgeCode: string) {
    super(message);
    this.name = "BacklogBridgeError";
    this.bridgeCode = bridgeCode;
  }
}

/** Bridge codes that mean "try again later"; they keep the shared outage handling. */
const TRANSIENT_BRIDGE_CODES = new Set(["WORKER_UNAVAILABLE", "TIMEOUT"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toBridgeError(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err;
  const body = record(err.body);
  const code = typeof body?.code === "string" ? body.code : null;
  const message = typeof body?.message === "string" ? body.message : null;
  // Only worker failures are rewrapped; auth, outage, a restarting worker
  // and other HTTP errors keep their ApiError and the shared error copy.
  if (!code || !message || TRANSIENT_BRIDGE_CODES.has(code)) return err;
  return new BacklogBridgeError(message, code);
}

async function bridge<T>(call: () => Promise<{ data: unknown }>): Promise<T> {
  try {
    const response = await call();
    return response.data as T;
  } catch (err) {
    throw toBridgeError(err);
  }
}

/**
 * True when the worker says ADO no longer has the work item. The plugin's
 * not-found arrives as a worker error (502 with `{ code, message }`).
 */
export function isWorkItemNotFoundError(err: unknown): boolean {
  return err instanceof BacklogBridgeError && /not\s+found|does not exist|no longer/i.test(err.message);
}

/**
 * True when the bridge cannot reach the plugin at all: 404 (no plugin with
 * that id, e.g. uninstalled since the page loaded) or 501 (bridge disabled).
 */
export function isPluginUnavailableError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 501);
}

export const backlogApi = {
  getBacklog: (pluginId: string, companyId: string) =>
    bridge<BacklogData>(() =>
      pluginsApi.bridgeGetData(pluginId, BACKLOG_DATA_KEYS.backlog, {}, companyId),
    ),

  getWorkItem: (pluginId: string, companyId: string, workItemId: number) =>
    bridge<WorkItemDetail>(() =>
      pluginsApi.bridgeGetData(pluginId, BACKLOG_DATA_KEYS.workItem, { workItemId }, companyId),
    ),

  syncBacklog: (pluginId: string, companyId: string) =>
    bridge<SyncBacklogResult>(() =>
      pluginsApi.bridgePerformAction(pluginId, BACKLOG_ACTION_KEYS.syncBacklog, {}, companyId),
    ),

  assignAgent: (pluginId: string, companyId: string, params: AssignAgentParams) =>
    bridge<AssignAgentResult>(() =>
      pluginsApi.bridgePerformAction(
        pluginId,
        BACKLOG_ACTION_KEYS.assignAgent,
        { workItemId: params.workItemId, agentId: params.agentId },
        companyId,
      ),
    ),
};
