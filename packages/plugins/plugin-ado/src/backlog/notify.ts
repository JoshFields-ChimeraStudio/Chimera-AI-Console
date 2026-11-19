/**
 * Live updates for the Backlog page. The plugin emits a small "changed" signal on the
 * company's `backlog` stream; the page re-reads its data when it sees one. The signal
 * carries no work item content, only what changed, so nothing sensitive goes over it.
 *
 * The host keeps one company per channel name in the worker, so the channel is
 * (re)opened for the company before each emit. Emits from a host call (an action or
 * an event) are allowed for that call's company; emits from background work carry no
 * invocation and are allowed for companies with saved settings.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";

export const BACKLOG_STREAM_CHANNEL = "backlog";

export interface BacklogChangedEvent {
  type: "changed";
  reason: "work-item" | "sync" | "assign" | "link" | "task";
  workItemId?: number;
}

export function notifyBacklogChanged(ctx: PluginContext, companyId: string, event: Omit<BacklogChangedEvent, "type">): void {
  try {
    ctx.streams.open(BACKLOG_STREAM_CHANNEL, companyId);
    ctx.streams.emit(BACKLOG_STREAM_CHANNEL, { type: "changed", ...event } satisfies BacklogChangedEvent);
  } catch (err) {
    // Live updates are a convenience: never let them break the change itself.
    ctx.logger.debug("Could not emit a Backlog update", { companyId, error: err instanceof Error ? err.message : String(err) });
  }
}
