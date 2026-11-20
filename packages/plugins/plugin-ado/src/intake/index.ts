/**
 * A3: ADO hands new work to an agent without anyone opening Paperclip.
 *
 * Josh tags a top-level work item (an Epic, or a Bug, which has no parent) `for:<Agent>` in ADO,
 * for example for:Tiamat. When the plugin sees the item (a live event, the catch-up after a
 * restart, or a full sync) and it has no linked task yet, it creates the task assigned to that
 * agent and wakes it, as an assignment from the Backlog view would.
 *
 * Idempotent and safe: only items with no linked task at all are picked up, so finished work is
 * never reopened and nothing already assigned changes hands; final items are ignored; items with a
 * parent are left to the director and to the builder routes (A6), whose `for:` tags they share.
 * A tag naming no assignable agent is reported once on the item, not on every sync.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { WorkItemSummary } from "../ado/client.js";
import type { Assigner } from "../backlog/assign.js";
import { BacklogError } from "../backlog/errors.js";
import type { PluginDeps } from "../deps.js";
import type { LinkFeatures } from "../links/index.js";
import { forAgentOf } from "../routing/index.js";
import { attributedHtml } from "../tools/html.js";
import { FINAL_STATES, PLUGIN_SIGNATURE } from "../workflow/rules.js";

export interface IntakeOptions {
  deps: PluginDeps;
  links: Pick<LinkFeatures, "findTaskForWorkItem">;
  assigner: Pick<Assigner, "assign">;
}

export type IntakeOutcome =
  | { kind: "skipped" }
  | { kind: "assigned"; agent: string; issueId: string }
  | { kind: "refused"; reason: string };

const lower = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** The item got a linked task between the check and the assignment: not new work after all. */
class AlreadyLinked extends BacklogError {
  constructor() {
    super("This work item already has a linked task");
  }
}

export function createIntake(options: IntakeOptions) {
  const { deps, links, assigner } = options;
  const ctx: PluginContext = deps.ctx;
  /** One pick-up per work item at a time (an event and a sync can arrive together). */
  const running = new Map<string, Promise<IntakeOutcome>>();
  const refusedKey = (companyId: string, id: number) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: `intake-refused:${id}` });

  async function pickUp(companyId: string, item: WorkItemSummary): Promise<IntakeOutcome> {
    if (item.parentId || FINAL_STATES.some((f) => lower(f) === lower(item.state))) return { kind: "skipped" };
    // Cheap check first: anything with a linked task (open or finished) is not new work.
    if (await links.findTaskForWorkItem(companyId, item.id)) return { kind: "skipped" };
    const ado = await deps.adoClient(companyId);
    const live = await ado.getWorkItem(item.id);
    if (live.fields["System.Parent"]) return { kind: "skipped" };
    const name = forAgentOf(live.fields["System.Tags"]);
    if (!name) return { kind: "skipped" };

    const agents = await ctx.agents.list({ companyId, limit: 500 });
    const agent = agents.find((a) => lower(a.name) === lower(name) && a.status !== "terminated") ?? null;
    let reason: string | null = agent ? null : `no agent is called ${name}`;
    let assigned: { issueId: string } | null = null;
    if (agent) {
      try {
        assigned = await assigner.assign({
          companyId,
          workItemId: item.id,
          agentId: agent.id,
          actor: { actorUserId: null },
          wakeSource: "plugin.ado.intake",
          // Checked again inside the assignment lock: someone may have assigned it a moment ago.
          async authorize(facts) {
            if (facts.task) throw new AlreadyLinked();
          },
        });
      } catch (err) {
        if (err instanceof AlreadyLinked) return { kind: "skipped" };
        if (!(err instanceof BacklogError)) throw err;
        reason = err.message;
      }
    }
    if (assigned && agent) {
      await ado
        .addComment(item.id, attributedHtml(PLUGIN_SIGNATURE, `Picked up for ${agent.name} (tag for:${name}); its Paperclip task is created and ${agent.name} is woken.`))
        .catch(() => undefined);
      await ctx.state.delete(refusedKey(companyId, item.id)).catch(() => undefined);
      ctx.logger.info("ADO intake: work item picked up", { companyId, workItemId: item.id, agent: agent.name });
      return { kind: "assigned", agent: agent.name, issueId: assigned.issueId };
    }
    // Say so once per tag, not on every sync.
    const said = (await ctx.state.get(refusedKey(companyId, item.id))) as { tag?: string } | null;
    if (said?.tag !== lower(name)) {
      await ado
        .addComment(item.id, attributedHtml(PLUGIN_SIGNATURE, `Not picked up: the tag for:${name} names no agent that can take it (${reason}). Fix the tag, or assign it from the Backlog view.`))
        .catch(() => undefined);
      await ctx.state.set(refusedKey(companyId, item.id), { tag: lower(name), reason });
    }
    return { kind: "refused", reason: reason! };
  }

  /** Called for every work item the plugin processes (live, catch-up or full sync). Never throws. */
  async function onWorkItem(companyId: string, item: WorkItemSummary): Promise<IntakeOutcome> {
    const key = `${companyId}:${item.id}`;
    const inFlight = running.get(key);
    if (inFlight) return inFlight;
    const p = pickUp(companyId, item)
      .catch((err): IntakeOutcome => {
        ctx.logger.warn("ADO intake failed", { companyId, workItemId: item.id, error: err instanceof Error ? err.message : String(err) });
        return { kind: "skipped" };
      })
      .finally(() => running.delete(key));
    running.set(key, p);
    return p;
  }

  return { onWorkItem };
}

export type Intake = ReturnType<typeof createIntake>;
