/**
 * A6: the plugin assigns approved work by rules, with a limit on how much each builder holds.
 *
 * The planner records who should do what when he creates the items, as tags:
 * - "builder:<role>" on a User Story or Bug (for example builder:backend): the kind of builder it needs;
 * - "for:<Agent>" on a Review, QA Test or Task: the agent it goes to (for example for:Ladon).
 * The `builderRoutes` setting maps each builder role to its agents and how many open Stories (and
 * Bugs) each may hold at once.
 *
 * When Josh sets a Feature Ready For Work, before its owner is woken, the plugin assigns every
 * "for:" item under it and as many tagged Stories as builders have room for: the builder of the
 * role with the fewest open Stories, in the order the route lists them. A Story whose description
 * says "Depends on #<id>" waits until that item is Completed (or Removed). When a Story or Bug is
 * finished, the next waiting Story gets the free slot. Stories without a builder tag, and anything
 * already assigned, stay with the director as before. The judgement of who suits a Story stays with
 * the planner; the plugin only follows the table and counts.
 */
import type { Agent, Issue, PluginContext } from "@paperclipai/plugin-sdk";
import type { AdoClient, AdoWorkItem, WorkItemSummary } from "../ado/client.js";
import type { Assigner } from "../backlog/assign.js";
import type { PluginDeps } from "../deps.js";
import type { LinkFeatures } from "../links/index.js";
import { attributedHtml, htmlToText } from "../tools/html.js";
import { FINAL_STATES, PLUGIN_SIGNATURE } from "../workflow/rules.js";

export const BUILDER_TAG_PREFIX = "builder:";
export const FOR_TAG_PREFIX = "for:";
/** The Feature state that releases its work (Josh's approval of the breakdown). */
export const RELEASE_STATE = "ready for work";
/** Feature states whose waiting Stories may be started. */
const ACTIVE_FEATURE_STATES = new Set(["ready for work", "in progress"]);
const BUILD_TYPES = new Set(["user story", "bug"]);
const FOR_TYPES = new Set(["review", "qa test", "task"]);
const CLOSED_TASK = new Set(["done", "cancelled"]);
/** At most this many waiting Stories are looked at per pass. */
const MAX_WAITING = 500;

export interface BuilderRoute {
  role: string;
  /** Agent names, in order of preference on a tie. */
  agents: string[];
  /** Open Stories and Bugs one agent of this route may hold (at least 1). */
  wipLimit: number;
}

function splitTags(tags: unknown): string[] {
  return typeof tags === "string"
    ? tags
        .split(";")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
}

function tagValue(tags: unknown, prefix: string): string | null {
  const tag = splitTags(tags).find((t) => t.toLowerCase().startsWith(prefix));
  const value = tag?.slice(prefix.length).trim();
  return value || null;
}

export const builderRoleOf = (tags: unknown) => tagValue(tags, BUILDER_TAG_PREFIX);
export const forAgentOf = (tags: unknown) => tagValue(tags, FOR_TAG_PREFIX);

/** The tags with a "<prefix><value>" tag set (any previous one of that prefix replaced). */
export function withTag(currentTags: unknown, prefix: string, value: string): string {
  const kept = splitTags(currentTags).filter((t) => !t.toLowerCase().startsWith(prefix));
  const clean = value.replace(/[;,]/g, " ").replace(/\s+/g, " ").trim();
  return [...kept, `${prefix}${clean}`].join("; ");
}

/** The `builderRoutes` setting, cleaned: rows with a role and at least one agent. */
export function parseRoutes(raw: unknown): BuilderRoute[] {
  if (!Array.isArray(raw)) return [];
  const out: BuilderRoute[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const role = typeof r?.role === "string" ? r.role.trim() : "";
    const agents = (typeof r?.agents === "string" ? r.agents.split(",") : Array.isArray(r?.agents) ? (r.agents as unknown[]) : [])
      .map((a) => String(a).trim())
      .filter(Boolean);
    const limit = Number(r?.wipLimit);
    if (role && agents.length) out.push({ role, agents, wipLimit: Number.isInteger(limit) && limit >= 1 ? limit : 1 });
  }
  return out;
}

export function routeFor(routes: BuilderRoute[], role: string): BuilderRoute | null {
  return routes.find((r) => r.role.toLowerCase() === role.trim().toLowerCase()) ?? null;
}

/** "Depends on #12" (or "Depends on #12, #13") in a description. */
export function dependenciesOf(descriptionHtml: unknown): number[] {
  if (typeof descriptionHtml !== "string") return [];
  const out = new Set<number>();
  for (const m of htmlToText(descriptionHtml).matchAll(/depends on((?:\s*,?\s*(?:and\s+)?#\d+)+)/gi)) {
    for (const id of m[1]!.matchAll(/#(\d+)/g)) out.add(Number(id[1]));
  }
  return [...out];
}

const isFinal = (state: string) => FINAL_STATES.some((f) => f.toLowerCase() === state.trim().toLowerCase());
const lower = (s: unknown) => String(s ?? "").trim().toLowerCase();

export interface RoutingOptions {
  deps: PluginDeps;
  links: Pick<LinkFeatures, "findTaskForWorkItem" | "findLinkByIssue">;
  assigner: Pick<Assigner, "assign">;
  /** The company's `builderRoutes` setting. */
  routes(companyId: string): Promise<BuilderRoute[]>;
}

export interface RoutingResult {
  assigned: Array<{ workItemId: number; agent: string; why: string }>;
  waiting: Array<{ workItemId: number; why: string }>;
}

export function createRouter(options: RoutingOptions) {
  const { deps, links, assigner } = options;
  const ctx: PluginContext = deps.ctx;
  /** One pass per company at a time, so two finished Stories cannot both take the same free slot. */
  const queues = new Map<string, Promise<unknown>>();

  function serial<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(companyId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    queues.set(companyId, next);
    return next;
  }

  async function agentsByName(companyId: string): Promise<Map<string, Agent>> {
    const all = await ctx.agents.list({ companyId, limit: 500 });
    const out = new Map<string, Agent>();
    for (const a of all) {
      if (a.status === "terminated") continue;
      if (!out.has(lower(a.name))) out.set(lower(a.name), a);
    }
    return out;
  }

  /** Open Stories and Bugs an agent holds: its open linked tasks whose work item is one. */
  async function load(companyId: string, agentId: string): Promise<number> {
    const tasks = await ctx.issues.list({ companyId, assigneeAgentId: agentId, limit: 500 } as never).catch(() => [] as Issue[]);
    let n = 0;
    for (const t of tasks) {
      if (CLOSED_TASK.has(t.status)) continue;
      const link = await links.findLinkByIssue(companyId, t.id).catch(() => null);
      if (link && BUILD_TYPES.has(lower(link.type)) && !isFinal(link.state)) n++;
    }
    return n;
  }

  async function held(companyId: string, workItemId: number): Promise<boolean> {
    const task = await links.findTaskForWorkItem(companyId, workItemId);
    return !!task?.assigneeAgentId && !CLOSED_TASK.has(task.status);
  }

  async function assign(companyId: string, ado: AdoClient, item: AdoWorkItem, agent: Agent, why: string): Promise<void> {
    await assigner.assign({ companyId, workItemId: item.id, agentId: agent.id, actor: { actorUserId: null }, wakeSource: "plugin.ado.routing" });
    await ado.addComment(item.id, attributedHtml(PLUGIN_SIGNATURE, `Assigned to ${agent.name}: ${why}.`)).catch((err) =>
      ctx.logger.warn("Could not comment on an auto-assigned item", { workItemId: item.id, error: err instanceof Error ? err.message : String(err) }),
    );
  }

  async function children(ado: AdoClient, item: AdoWorkItem): Promise<AdoWorkItem[]> {
    const ids = (item.relations ?? [])
      .filter((r) => r.rel === "System.LinkTypes.Hierarchy-Forward")
      .map((r) => Number(r.url.match(/\/workItems\/(\d+)$/i)?.[1]))
      .filter((n) => n > 0);
    const out: AdoWorkItem[] = [];
    for (const id of ids) {
      const c = await ado.getWorkItem(id).catch(() => null);
      if (c) out.push(c);
    }
    return out;
  }

  /** "for:" items under a Story or Bug, and its untagged Tasks to the Story's builder (when it has one). */
  async function assignChildren(companyId: string, ado: AdoClient, story: AdoWorkItem, builder: Agent | null, agents: Map<string, Agent>, result: RoutingResult) {
    for (const c of await children(ado, story)) {
      const type = lower(c.fields["System.WorkItemType"]);
      if (!FOR_TYPES.has(type) || isFinal(String(c.fields["System.State"] ?? "")) || (await held(companyId, c.id))) continue;
      const forName = forAgentOf(c.fields["System.Tags"]);
      const agent = forName ? agents.get(lower(forName)) : type === "task" ? builder : null;
      if (!agent) {
        if (forName) result.waiting.push({ workItemId: c.id, why: `no agent called ${forName}` });
        continue;
      }
      await assign(companyId, ado, c, agent, forName ? `the planner named ${agent.name} for it` : `the builder of #${story.id}`);
      result.assigned.push({ workItemId: c.id, agent: agent.name, why: forName ? "for tag" : "story builder" });
    }
  }

  /** Start waiting Stories (oldest-ranked first) while builders have room. */
  async function fill(companyId: string, ado: AdoClient, candidates: AdoWorkItem[], result: RoutingResult): Promise<void> {
    const routes = await options.routes(companyId);
    if (!routes.length) return;
    const agents = await agentsByName(companyId);
    const loads = new Map<string, number>();
    const loadOf = async (a: Agent) => {
      if (!loads.has(a.id)) loads.set(a.id, await load(companyId, a.id));
      return loads.get(a.id)!;
    };
    const featureState = new Map<number, string>();
    for (const story of candidates) {
      const role = builderRoleOf(story.fields["System.Tags"]);
      if (!role || !BUILD_TYPES.has(lower(story.fields["System.WorkItemType"]))) continue;
      if (isFinal(String(story.fields["System.State"] ?? "")) || (await held(companyId, story.id))) continue;
      // A Story under a Feature is released only once Josh approved the Feature.
      const parentId = Number(story.fields["System.Parent"] ?? 0);
      if (parentId) {
        if (!featureState.has(parentId)) featureState.set(parentId, lower((await ado.getWorkItem(parentId).catch(() => null))?.fields["System.State"]));
        if (!ACTIVE_FEATURE_STATES.has(featureState.get(parentId)!)) continue;
      }
      const route = routeFor(routes, role);
      if (!route) {
        result.waiting.push({ workItemId: story.id, why: `no route for builder role ${role}` });
        continue;
      }
      const needs = dependenciesOf(story.fields["System.Description"]);
      const open: number[] = [];
      for (const d of needs) {
        const s = await ado.getWorkItem(d).catch(() => null);
        if (s && !isFinal(String(s.fields["System.State"] ?? ""))) open.push(d);
      }
      if (open.length) {
        result.waiting.push({ workItemId: story.id, why: `depends on ${open.map((d) => `#${d}`).join(", ")}` });
        continue;
      }
      let best: { agent: Agent; load: number } | null = null;
      let available = 0;
      for (const name of route.agents) {
        const a = agents.get(lower(name));
        if (!a || a.status === "paused" || a.status === "pending_approval") continue;
        available++;
        const l = await loadOf(a);
        if (l < route.wipLimit && (!best || l < best.load)) best = { agent: a, load: l };
      }
      if (!best) {
        const why = available
          ? `every ${role} builder holds ${route.wipLimit} open Stor${route.wipLimit === 1 ? "y" : "ies"}`
          : `no ${role} builder is available (${route.agents.join(", ")}: missing, paused or not approved)`;
        result.waiting.push({ workItemId: story.id, why });
        continue;
      }
      const why = `builder role ${role}; ${best.agent.name} held ${best.load} of ${route.wipLimit} open Stories`;
      await assign(companyId, ado, story, best.agent, why);
      loads.set(best.agent.id, best.load + 1);
      result.assigned.push({ workItemId: story.id, agent: best.agent.name, why });
      await assignChildren(companyId, ado, story, best.agent, agents, result);
    }
  }

  /** Josh released a Feature: assign its "for:" items and start its Stories while builders have room. */
  async function releaseFeature(companyId: string, feature: WorkItemSummary): Promise<RoutingResult> {
    return serial(companyId, async () => {
      const result: RoutingResult = { assigned: [], waiting: [] };
      if (!(await options.routes(companyId)).length) return result;
      const ado = await deps.adoClient(companyId);
      const featureItem = await ado.getWorkItem(feature.id);
      const stories = (await children(ado, featureItem)).filter((c) => BUILD_TYPES.has(lower(c.fields["System.WorkItemType"])));
      const agents = await agentsByName(companyId);
      // Reviews and QA Tests go to their named agents now, whether or not their Story can start yet.
      for (const s of stories) {
        const builderTask = await links.findTaskForWorkItem(companyId, s.id);
        const builder = builderTask?.assigneeAgentId ? ([...agents.values()].find((a) => a.id === builderTask.assigneeAgentId) ?? null) : null;
        await assignChildren(companyId, ado, s, builder, agents, result);
      }
      await fill(companyId, ado, stories, result);
      log(companyId, `Feature #${feature.id} released`, result);
      if (result.assigned.length || result.waiting.length) {
        const lines = [
          `Assigned by the builder routes: ${result.assigned.length ? result.assigned.map((a) => `#${a.workItemId} to ${a.agent}`).join(", ") : "nothing"}.`,
          ...(result.waiting.length ? [`Waiting: ${result.waiting.map((w) => `#${w.workItemId} (${w.why})`).join("; ")}.`] : []),
        ];
        await ado.addComment(feature.id, attributedHtml(PLUGIN_SIGNATURE, lines.join("\n"))).catch(() => undefined);
      }
      return result;
    });
  }

  /** A Story or Bug finished (or anything that frees a builder): start the next waiting Stories. */
  async function fillSlots(companyId: string, reason: string): Promise<RoutingResult> {
    return serial(companyId, async () => {
      const result: RoutingResult = { assigned: [], waiting: [] };
      if (!(await options.routes(companyId)).length) return result;
      const ado = await deps.adoClient(companyId);
      const ids = await ado.queryWorkItemIds(
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('User Story', 'Bug') " +
          "AND [System.State] = 'New' ORDER BY [Microsoft.VSTS.Common.StackRank] ASC, [System.Id] ASC",
        MAX_WAITING,
      );
      const items: AdoWorkItem[] = [];
      for (const id of ids) {
        const it = await ado.getWorkItem(id).catch(() => null);
        if (it && builderRoleOf(it.fields["System.Tags"])) items.push(it);
      }
      await fill(companyId, ado, items, result);
      if (result.assigned.length) log(companyId, reason, result);
      return result;
    });
  }

  function log(companyId: string, why: string, r: RoutingResult) {
    ctx.logger.info("ADO routing", { companyId, why, assigned: r.assigned, waiting: r.waiting });
  }

  /** Watcher hook: a work item's state changed (called before its owner is told). */
  async function onStateChanged(companyId: string, item: WorkItemSummary): Promise<void> {
    const type = lower(item.type);
    const state = lower(item.state);
    if (type === "feature" && state === RELEASE_STATE) await releaseFeature(companyId, item);
    else if (BUILD_TYPES.has(type) && isFinal(item.state)) await fillSlots(companyId, `#${item.id} is ${item.state}`);
  }

  return { onStateChanged, releaseFeature, fillSlots };
}

export type Router = ReturnType<typeof createRouter>;
