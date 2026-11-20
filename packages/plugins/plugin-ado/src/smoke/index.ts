/**
 * A10: the smoke-test Epic. A dashboard widget creates a standard Epic in the test project,
 * assigned to the smoke-test agent, written to take every path of the workflow: a Document
 * reviewed as a pull request, a review that must ask for a change, and a QA failure that files a
 * Defect and is retested. Reset sets every open item of the previous smoke-test Epic Removed,
 * top down, so the board stays clean and nothing rolls up or wakes anyone on the way.
 *
 * The Epic's text below (smokeDescription) is the one copy of the smoke test (doc/plans/2026-11-14-ado-integration.md, A10).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AdoClient, AdoWorkItem, JsonPatchOp } from "../ado/client.js";
import type { PluginDeps } from "../deps.js";
import type { Assigner } from "../backlog/assign.js";
import { BacklogError } from "../backlog/errors.js";
import { attributedHtml, textToHtml } from "../tools/html.js";
import { FINAL_STATES, PLUGIN_SIGNATURE } from "../workflow/rules.js";

export const SMOKE_DATA_KEY = "smoke-test";
export const SMOKE_ACTION_KEYS = { start: "smoke-test-start", cleanUp: "smoke-test-clean-up" } as const;
export const SMOKE_STATE_KEY = "smoke-test-epic";
export const REMOVED_STATE = "Removed";
/** Reset walks at most this many items, so a wrong Epic ID cannot sweep the project. */
export const SMOKE_MAX_ITEMS = 200;

export const SMOKE_TITLE = "Smoke test: full workflow";

/**
 * The file each smoke test adds. A new name every run (from the creation time, to the second), so a run
 * never finds the previous run's file already on main.
 */
export function smokeFileName(at: Date): string {
  return `smoke/hello-${at.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}.txt`;
}

export function smokeDescription(file: string): string {
  return [
    "Smoke test of the ADO workflow, created by the ADO plugin. Nothing here is real work: keep every change as small as it can be.",
    "",
    `Build: add a new file ${file} to SimpleRepo with two lines: "Hello from the smoke test", then today's date. The file does not exist yet; do not change or reuse the files of earlier smoke tests.`,
    "",
    "Documentation: one Document, a few sentences describing the file and its two lines.",
    "",
    "Plan: one Feature with one User Story for the file.",
    "",
    "Instructions from Josh:",
    "- Review: on the first review, request one change: a trailing newline at the end of the file (whether or not it already has one). Approve the fix.",
    "- QA Test: on the first run, fail the test with one Defect: the date line must start with \"Date: \". On the retest after the fix, pass if the second line starts with \"Date: \".",
  ].join("\n");
}

export function smokeAcceptanceCriteria(file: string): string {
  return [
    `${file} is on main with the two lines.`,
    "The Document was merged after one round of changes requested by Josh.",
    "The Review asked for one change and then approved.",
    "The QA Test failed once with a Defect, the Defect was fixed and retested, and the QA Test passed.",
    "The plugin completed the Feature and the Epic.",
  ].join("\n");
}

/** Josh's own part, shown in the widget (agents never see it). */
export const SMOKE_JOSH_STEPS = [
  "On the Document's pull request, set the Document Changes Requested once, then merge the fix.",
  "Approve the plan: set the Epic In Progress.",
  "Approve the breakdown: set the Feature Ready For Work.",
  "Merge the Story's pull request when it is Ready To Merge, and the Defect fix's when it is.",
];

export interface SmokeRecord {
  epicId: number;
  createdAt: string;
  agentName: string;
}

export interface SmokeData {
  configured: boolean;
  /** The smoke-test agent from the settings; null when not set (the buttons are off). */
  agentName: string | null;
  epic: { id: number; title: string; state: string; url: string; createdAt: string } | null;
  joshSteps: string[];
}

export interface CleanUpResult {
  removed: number[];
  alreadyFinal: number[];
  failed: Array<{ id: number; error: string }>;
  truncated: boolean;
}

export type StartResult = { epicId: number; url: string; assignedTo: string; cleanedUp: CleanUpResult | null };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const CHILD_REL = "System.LinkTypes.Hierarchy-Forward";

function childIds(item: AdoWorkItem): number[] {
  return (item.relations ?? [])
    .filter((r) => r.rel === CHILD_REL)
    .map((r) => Number(r.url.match(/\/workItems\/(\d+)$/i)?.[1]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Sets every item of the tree under `epicId` (the Epic included) that is not final to Removed
 * (Completed for a type without Removed),
 * parents before children: a removed parent cannot roll up, and its closed task wakes no one.
 */
export async function cleanUpTree(ado: AdoClient, epicId: number, now: () => Date = () => new Date()): Promise<CleanUpResult> {
  const result: CleanUpResult = { removed: [], alreadyFinal: [], failed: [], truncated: false };
  const queue = [epicId];
  const seen = new Set<number>();
  const note = attributedHtml(PLUGIN_SIGNATURE, `Closed by a smoke-test reset (${now().toISOString()}).`);
  /** Removed, or Completed for a type that has no Removed state. */
  const closingState = new Map<string, Promise<string>>();
  const closeTo = (type: string) => {
    if (!closingState.has(type)) {
      closingState.set(
        type,
        ado
          .getWorkItemTypeStates(type)
          .then((states) => (states.some((s) => s.name.toLowerCase() === REMOVED_STATE.toLowerCase()) ? REMOVED_STATE : "Completed"))
          .catch(() => REMOVED_STATE),
      );
    }
    return closingState.get(type)!;
  };
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    if (seen.size >= SMOKE_MAX_ITEMS) {
      result.truncated = true;
      break;
    }
    seen.add(id);
    let item: AdoWorkItem;
    try {
      item = await ado.getWorkItem(id);
    } catch (err) {
      result.failed.push({ id, error: errorText(err) });
      continue;
    }
    queue.push(...childIds(item));
    const state = String(item.fields["System.State"] ?? "");
    if (FINAL_STATES.some((s) => s.toLowerCase() === state.toLowerCase())) {
      result.alreadyFinal.push(id);
      continue;
    }
    const ops: JsonPatchOp[] = [
      { op: "test", path: "/rev", value: item.rev },
      { op: "add", path: "/fields/System.State", value: await closeTo(String(item.fields["System.WorkItemType"] ?? "")) },
      { op: "add", path: "/fields/System.History", value: note },
    ];
    try {
      await ado.updateWorkItem(id, ops);
      result.removed.push(id);
    } catch (err) {
      result.failed.push({ id, error: errorText(err) });
    }
  }
  return result;
}

export async function createSmokeEpic(ado: AdoClient, now: () => Date = () => new Date()): Promise<AdoWorkItem> {
  const at = now();
  const stamp = at.toISOString().slice(0, 16).replace("T", " ");
  const file = smokeFileName(at);
  return ado.createWorkItem("Epic", [
    { op: "add", path: "/fields/System.Title", value: `${SMOKE_TITLE} (${stamp} UTC)` },
    { op: "add", path: "/fields/System.Description", value: textToHtml(smokeDescription(file)) },
    { op: "add", path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", value: textToHtml(smokeAcceptanceCriteria(file)) },
    { op: "add", path: "/fields/System.History", value: attributedHtml(PLUGIN_SIGNATURE, "Created as a smoke test from the Azure DevOps widget.") },
  ]);
}

export interface SmokeOptions {
  deps: PluginDeps;
  assigner: Assigner;
  /** The smoke-test agent's name from the company's settings, or null. */
  smokeTestAgent(companyId: string): Promise<string | null>;
}

export function registerSmokeTest(options: SmokeOptions): void {
  const { deps, assigner } = options;
  const ctx: PluginContext = deps.ctx;
  const scope = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: SMOKE_STATE_KEY });
  /** One start or clean-up per company at a time, so a double click cannot make two Epics. */
  const running = new Set<string>();

  function companyIdFrom(params: Record<string, unknown>, fallback?: string | null): string {
    const id = typeof params.companyId === "string" && params.companyId ? params.companyId : fallback;
    if (!id) throw new BacklogError("companyId is required");
    return id;
  }

  function requireUser(context: { actor?: { type?: string; userId?: string | null } } | undefined): string {
    if (context?.actor?.type !== "user" || !context.actor.userId) throw new BacklogError("Only a board user can run the smoke test");
    return context.actor.userId;
  }

  async function record(companyId: string): Promise<SmokeRecord | null> {
    return ((await ctx.state.get(scope(companyId))) as SmokeRecord | null) ?? null;
  }

  async function findAgent(companyId: string, name: string) {
    const all = await ctx.agents.list({ companyId, limit: 500 });
    const named = all.filter((a) => a.name.trim().toLowerCase() === name.trim().toLowerCase() && a.status !== "terminated");
    if (named.length !== 1) throw new BacklogError(named.length ? `More than one agent is called "${name}".` : `No agent called "${name}" was found in this company.`);
    return named[0]!;
  }

  async function cleanUp(companyId: string): Promise<CleanUpResult | null> {
    const prev = await record(companyId);
    if (!prev) return null;
    const ado = await deps.adoClient(companyId);
    const result = await cleanUpTree(ado, prev.epicId, () => new Date(deps.now()));
    ctx.logger.info("Smoke-test reset", { companyId, epicId: prev.epicId, ...result, failed: result.failed.length });
    // Keep the record when something could not be removed, so the next reset tries again.
    if (!result.failed.length && !result.truncated) await ctx.state.delete(scope(companyId));
    return result;
  }

  async function exclusive<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    if (running.has(companyId)) throw new BacklogError("A smoke-test start or clean-up is already running");
    running.add(companyId);
    try {
      return await fn();
    } finally {
      running.delete(companyId);
    }
  }

  ctx.data.register(SMOKE_DATA_KEY, async (params): Promise<SmokeData> => {
    const companyId = companyIdFrom(params);
    const settings = await deps.settings(companyId);
    const agentName = settings ? await options.smokeTestAgent(companyId) : null;
    const prev = settings ? await record(companyId) : null;
    let epic: SmokeData["epic"] = null;
    if (prev) {
      try {
        const live = await (await deps.adoClient(companyId)).getWorkItemSummary(prev.epicId);
        epic = { id: live.id, title: live.title, state: live.state, url: live.webUrl, createdAt: prev.createdAt };
      } catch {
        epic = { id: prev.epicId, title: SMOKE_TITLE, state: "unknown", url: "", createdAt: prev.createdAt };
      }
    }
    return { configured: !!settings, agentName, epic, joshSteps: SMOKE_JOSH_STEPS };
  });

  // Start: clean up the previous smoke test (if any), create a new Epic and assign it to the smoke-test agent.
  ctx.actions.register(SMOKE_ACTION_KEYS.start, async (params, context): Promise<StartResult> => {
    const companyId = companyIdFrom(params, context?.companyId);
    const userId = requireUser(context);
    const agentName = await options.smokeTestAgent(companyId);
    if (!agentName) throw new BacklogError("Set the smoke-test agent in the Azure DevOps settings first");
    return exclusive(companyId, async () => {
      const agent = await findAgent(companyId, agentName);
      const cleanedUp = await cleanUp(companyId);
      if (cleanedUp && (cleanedUp.failed.length || cleanedUp.truncated)) {
        throw new BacklogError(
          `The previous smoke test could not be cleaned up completely (${cleanedUp.failed.map((f) => `#${f.id}: ${f.error}`).join("; ") || "too many items"}). Nothing new was created.`,
        );
      }
      const ado = await deps.adoClient(companyId);
      const epic = await createSmokeEpic(ado, () => new Date(deps.now()));
      await ctx.state.set(scope(companyId), { epicId: epic.id, createdAt: new Date(deps.now()).toISOString(), agentName: agent.name } satisfies SmokeRecord);
      await assigner.assign({ companyId, workItemId: epic.id, agentId: agent.id, actor: { actorUserId: userId }, wakeSource: "plugin.ado.smoke-test" });
      return { epicId: epic.id, url: ado.webUrl(epic.id), assignedTo: agent.name, cleanedUp };
    });
  });

  ctx.actions.register(SMOKE_ACTION_KEYS.cleanUp, async (params, context): Promise<CleanUpResult | null> => {
    const companyId = companyIdFrom(params, context?.companyId);
    requireUser(context);
    return exclusive(companyId, () => cleanUp(companyId));
  });
}
