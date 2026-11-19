import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Agent } from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import type { BacklogTreeNode } from "../../lib/backlog/tree";
import { BacklogRow, backlogWorkItemPath } from "./BacklogRow";

/** Above this many rows, off-screen rows skip layout and paint (as the Tasks list does). */
const DEFERRED_ROW_THRESHOLD = 150;

/**
 * An ARIA tree over the flattened Backlog rows. The DOM stays flat, as in the
 * Tasks list, so nesting is expressed with `aria-level`, `aria-posinset` and
 * `aria-setsize` instead of `role="group"` wrappers (the APG flat-tree form).
 * One row is tabbable at a time; Up/Down move, Right expands or enters the
 * first child, Left collapses or moves to the parent, Home/End jump, Enter
 * opens the work item.
 */
export function BacklogTree({
  label,
  rows,
  collapsed,
  onToggle,
  agentById,
  deferRows,
}: {
  label: string;
  rows: BacklogTreeNode[];
  collapsed: ReadonlySet<number>;
  onToggle: (workItemId: number) => void;
  agentById: ReadonlyMap<string, Agent>;
  deferRows?: boolean;
}) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const pendingFocus = useRef<number | null>(null);
  const indexById = useMemo(() => new Map(rows.map((node, index) => [node.item.id, index])), [rows]);
  const tabbableId = focusedId !== null && indexById.has(focusedId) ? focusedId : rows[0]?.item.id ?? null;
  const defer = deferRows ?? rows.length > DEFERRED_ROW_THRESHOLD;

  const focusRow = (id: number) => {
    setFocusedId(id);
    const element = containerRef.current?.querySelector<HTMLElement>(`[data-backlog-row-id="${id}"]`);
    if (element) {
      element.focus();
      pendingFocus.current = null;
    } else {
      pendingFocus.current = id;
    }
  };

  // A row that only appears after this render (entering a just-expanded row).
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null || !indexById.has(id)) return;
    const element = containerRef.current?.querySelector<HTMLElement>(`[data-backlog-row-id="${id}"]`);
    if (element && document.activeElement !== element) element.focus();
    pendingFocus.current = null;
  }, [indexById]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabbableId === null ? -1 : indexById.get(tabbableId) ?? -1;
    const node = rows[index];
    if (!node) return;
    const expandable = node.children.length > 0;
    const expanded = expandable && !collapsed.has(node.item.id);
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        if (rows[index + 1]) focusRow(rows[index + 1]!.item.id);
        break;
      case "ArrowUp":
        if (rows[index - 1]) focusRow(rows[index - 1]!.item.id);
        break;
      case "Home":
        focusRow(rows[0]!.item.id);
        break;
      case "End":
        focusRow(rows[rows.length - 1]!.item.id);
        break;
      case "ArrowRight":
        if (expandable && !expanded) onToggle(node.item.id);
        else if (expanded) focusRow(node.children[0]!.item.id);
        break;
      case "ArrowLeft":
        if (expanded) onToggle(node.item.id);
        else if (node.treeParentId !== null && indexById.has(node.treeParentId)) focusRow(node.treeParentId);
        break;
      case "Enter":
        navigate(backlogWorkItemPath(node.item.id));
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  return (
    <div ref={containerRef} role="tree" aria-label={label} className="flex flex-col" onKeyDown={onKeyDown}>
      {rows.map((node) => (
        <BacklogRow
          key={node.item.id}
          node={node}
          expanded={!collapsed.has(node.item.id)}
          onToggle={onToggle}
          agent={agentForNode(node, agentById)}
          tabbable={node.item.id === tabbableId}
          onFocusRow={setFocusedId}
          deferred={defer}
        />
      ))}
    </div>
  );
}

function agentForNode(node: BacklogTreeNode, agentById: ReadonlyMap<string, Agent>): Agent | null {
  const agentId = node.item.linkedTask?.assigneeAgentId;
  return agentId ? agentById.get(agentId) ?? null : null;
}
