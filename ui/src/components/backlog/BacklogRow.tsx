import type { Agent } from "@paperclipai/shared";
import { ChevronRight } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "../../lib/utils";
import type { BacklogTreeNode } from "../../lib/backlog/tree";
import { AgentIdentity } from "../AgentIdentity";
import { WorkItemStateBadge } from "./WorkItemStateBadge";
import { WorkItemTypeIcon } from "./WorkItemTypeIcon";

export function backlogWorkItemPath(workItemId: number): string {
  return `/backlog/${workItemId}`;
}

/**
 * One Backlog tree row. Follows the Tasks list row (legacy `IssueRow`): a
 * full-row overlay link, the w-4 disclosure column, tree guides per level, a
 * mono ID, a truncating title and trailing state and agent cells. The row is
 * the ARIA treeitem; `BacklogTree` handles its keyboard navigation.
 */
export function BacklogRow({
  node,
  expanded,
  onToggle,
  agent,
  tabbable,
  onFocusRow,
  deferred,
}: {
  node: BacklogTreeNode;
  expanded: boolean;
  onToggle: (workItemId: number) => void;
  agent: Agent | null;
  /** The tree's one tabbable row (roving tabindex). */
  tabbable: boolean;
  onFocusRow: (workItemId: number) => void;
  deferred?: boolean;
}) {
  const { item, depth, children, contextOnly, closed, descendantCount } = node;
  const hasChildren = children.length > 0;
  const accessibleName = [
    `${item.type} ${item.id}: ${item.title}`,
    item.state,
    contextOnly ? "closed, shown for its open items" : null,
    agent ? `agent ${agent.name}` : null,
  ].filter(Boolean).join(", ");
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={node.posInSet}
      aria-setsize={node.setSize}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-label={accessibleName}
      tabIndex={tabbable ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocusRow(item.id);
      }}
      data-backlog-row-id={item.id}
      data-context-only={contextOnly || undefined}
      style={deferred ? { contentVisibility: "auto", containIntrinsicSize: "auto 2.5rem" } : undefined}
      className={cn(
        "group relative flex items-center gap-2 rounded-lg py-2 pl-1 pr-3 text-sm",
        "border-b border-border last:border-b-0 hover:bg-accent/50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "[&_button]:relative [&_button]:z-10",
        contextOnly && "opacity-60",
      )}
    >
      {/* Pointer target only: keyboard users open the row with Enter on the treeitem. */}
      <Link
        to={backlogWorkItemPath(item.id)}
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 rounded-lg no-underline text-inherit"
      />
      {Array.from({ length: depth }, (_, level) => (
        <span key={level} aria-hidden="true" className="relative w-4 shrink-0 self-stretch">
          <span className="absolute -inset-y-2 left-2 w-px bg-border" />
        </span>
      ))}
      {hasChildren ? (
        <button
          type="button"
          data-slot="icon-button"
          tabIndex={-1}
          aria-hidden="true"
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
          aria-label={expanded ? `Collapse ${item.id}` : `Expand ${item.id}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggle(item.id);
          }}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} />
        </button>
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <WorkItemTypeIcon type={item.type} typeColor={item.typeColor} />
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.id}</span>
      <span
        data-slot="backlog-row-title"
        className={cn("min-w-0 flex-1 truncate", closed && "text-muted-foreground line-through")}
        title={contextOnly ? `${item.title} (${item.state}; shown because it has open items)` : item.title}
      >
        {item.title}
        {hasChildren && !expanded ? (
          <span className="ml-1.5 text-xs text-muted-foreground">
            ({descendantCount} item{descendantCount === 1 ? "" : "s"})
          </span>
        ) : null}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <WorkItemStateBadge state={item.state} stateCategory={item.stateCategory} />
        <span data-slot="backlog-row-agent" className="hidden w-36 min-w-0 justify-start sm:flex">
          {agent ? <AgentIdentity agent={agent} size="xs" className="text-muted-foreground" /> : null}
        </span>
      </span>
    </div>
  );
}
