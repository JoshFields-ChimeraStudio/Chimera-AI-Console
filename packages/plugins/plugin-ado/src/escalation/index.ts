/**
 * D9: a stronger model for a builder that is struggling (chosen by Josh, November 2026).
 *
 * Each agent keeps its configured model. When a Story or Bug reaches the last round of changes
 * a Review may ask for (the next request would be Blocked for Josh), or its QA Tests have failed
 * twice, the plugin sets the escalation model on the builder's linked task, as the task's
 * assignee adapter override. Paperclip uses the override for every later run on that task only,
 * so the builder's next turn (the fix) and the rest of that Story run on the stronger model; its
 * other Stories, and the other agents, are unchanged.
 *
 * Runs from the watcher's state-change hook, before the builder is woken by the same change.
 * The setting escalationModel names the model (empty turns this off).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AdoWorkItem, WorkItemSummary } from "../ado/client.js";
import type { PluginDeps } from "../deps.js";
import type { LinkFeatures } from "../links/index.js";
import { countReviewRounds, idFromUrl } from "../tools/index.js";
import { BLOCKED_STATE, QA_TEST_TYPE, REVIEW_ROUND_LIMIT, REVIEW_TYPE, CHANGES_REQUESTED_STATE, STORY_TYPES } from "../workflow/rules.js";

type Issue = NonNullable<Awaited<ReturnType<PluginContext["issues"]["get"]>>>;

/** The escalationModel setting's default. */
export const DEFAULT_ESCALATION_MODEL = "claude-opus-5-5";

/** QA Test failures, across a Story's QA Tests, that move its builder to the escalation model. */
export const QA_FAILURE_LIMIT = 2;
const FAILED_STATE = "failed";

const lower = (s: unknown) => String(s ?? "").trim().toLowerCase();

export interface EscalationOptions {
  deps: PluginDeps;
  links: Pick<LinkFeatures, "findTaskForWorkItem">;
  /** The model to escalate to, or null when escalation is off. */
  escalationModel(companyId: string): Promise<string | null>;
}

/** The model a task's override already sets, if any. */
export function overrideModel(task: Pick<Issue, "assigneeAdapterOverrides">): string | null {
  const model = task.assigneeAdapterOverrides?.adapterConfig?.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

/** How many times a work item moved to Failed. */
export function countFailures(updates: Array<{ fields?: Record<string, { newValue?: unknown } | undefined> }>): number {
  return updates.filter((u) => lower(u.fields?.["System.State"]?.newValue) === FAILED_STATE).length;
}

function childIds(item: AdoWorkItem): number[] {
  return (item.relations ?? [])
    .filter((r) => r.rel === "System.LinkTypes.Hierarchy-Forward")
    .map((r) => idFromUrl(r.url))
    .filter((id): id is number => id !== null);
}

export function createEscalation(options: EscalationOptions) {
  const { deps, links } = options;
  const { ctx } = deps;

  /** Why the Story above this item needs a stronger model now, or null. */
  async function reason(companyId: string, item: WorkItemSummary, story: AdoWorkItem): Promise<string | null> {
    const ado = await deps.adoClient(companyId);
    const type = lower(item.type);
    if (type === lower(REVIEW_TYPE) && lower(item.state) === lower(CHANGES_REQUESTED_STATE)) {
      const rounds = countReviewRounds(await ado.listUpdates(item.id));
      if (rounds >= REVIEW_ROUND_LIMIT - 1) {
        return `${REVIEW_TYPE} #${item.id} asked for changes ${rounds} times since it last approved: the last round before it goes to ${BLOCKED_STATE} for Josh`;
      }
      return null;
    }
    if (type === lower(QA_TEST_TYPE) && lower(item.state) === FAILED_STATE) {
      let failures = 0;
      for (const id of childIds(story)) {
        const child = id === item.id ? null : await ado.getWorkItem(id).catch(() => null);
        if (child && lower(child.fields["System.WorkItemType"]) !== lower(QA_TEST_TYPE)) continue;
        failures += countFailures(await ado.listUpdates(id));
      }
      return failures >= QA_FAILURE_LIMIT ? `its ${QA_TEST_TYPE}s have failed ${failures} times` : null;
    }
    return null;
  }

  /** Watcher hook: a work item's state changed (called before its owner is told). */
  async function onStateChanged(companyId: string, item: WorkItemSummary): Promise<void> {
    const type = lower(item.type);
    if (type !== lower(REVIEW_TYPE) && type !== lower(QA_TEST_TYPE)) return;
    if (!item.parentId) return;
    const model = await options.escalationModel(companyId);
    if (!model) return;
    const ado = await deps.adoClient(companyId);
    const story = await ado.getWorkItem(item.parentId);
    const storyType = lower(story.fields["System.WorkItemType"]);
    if (!STORY_TYPES.some((t) => lower(t) === storyType)) return;
    const task = await links.findTaskForWorkItem(companyId, story.id);
    if (!task?.assigneeAgentId || overrideModel(task) === model) return;
    const why = await reason(companyId, item, story);
    if (!why) return;

    // The host keeps the task's other overrides (fork patch 17).
    await ctx.issues.update(task.id, { assigneeAdapterOverrides: { adapterConfig: { model } } }, companyId);
    await ctx.issues.createComment(
      task.id,
      `Your next turns on ADO #${story.id} run on **${model}**: ${why}. Your other tasks keep your usual model.`,
      companyId,
    );
    ctx.logger.info("ADO model escalation", { companyId, workItemId: story.id, issueId: task.id, model, why });
  }

  return { onStateChanged };
}

export type Escalation = ReturnType<typeof createEscalation>;
