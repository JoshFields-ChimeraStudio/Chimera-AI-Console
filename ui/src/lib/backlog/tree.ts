import type { BacklogItem, BacklogStateCategory } from "./contract";

/**
 * Builds the Backlog tree from the flat `backlog` items.
 *
 * - Epics with no Epic above them are the top level; children nest by `parentId`.
 * - Items with no Epic anywhere in their ancestor chain (themselves included)
 *   form the "Not under an Epic" group, still as a tree. An Epic found below
 *   such an item is lifted to the top level with its own subtree.
 * - An item whose parent is not in the cache is treated as a root. A parent
 *   cycle is broken at an Epic on it if any, else at its first item.
 * - Siblings are ordered by `stackRank` (missing ranks last), then by `id`.
 * - With `showClosed` off, Completed and Removed items are hidden unless one of
 *   their descendants is visible; those stay as dimmed context rows so the
 *   open child keeps its place under its parent.
 *
 * Linear in the number of items (plus sorting siblings): one index pass, one
 * cycle-breaking walk, one memoized Epic-chain pass and one tree walk.
 */

export interface BacklogTreeNode {
  item: BacklogItem;
  depth: number;
  /** The row this one nests under in the tree (not always `item.parentId`). */
  treeParentId: number | null;
  /** 1-based position among visible siblings, and their count (for aria). */
  posInSet: number;
  setSize: number;
  children: BacklogTreeNode[];
  /** Completed or Removed. */
  closed: boolean;
  /** Closed and shown only because an open descendant is visible. */
  contextOnly: boolean;
  /** Visible descendants (all levels). */
  descendantCount: number;
}

export interface BacklogTree {
  epics: BacklogTreeNode[];
  noEpic: BacklogTreeNode[];
  /** Rows in the tree (all levels, both groups). */
  visibleCount: number;
  /** Items hidden by the closed filter. */
  hiddenClosedCount: number;
}

const CLOSED_CATEGORIES: ReadonlySet<BacklogStateCategory> = new Set(["Completed", "Removed"]);

export function isClosedBacklogItem(item: Pick<BacklogItem, "stateCategory">): boolean {
  return item.stateCategory !== null && CLOSED_CATEGORIES.has(item.stateCategory);
}

export function isEpic(item: Pick<BacklogItem, "type">): boolean {
  return item.type.trim().toLowerCase() === "epic";
}

export function compareBacklogItems(a: BacklogItem, b: BacklogItem): number {
  const ra = a.stackRank;
  const rb = b.stackRank;
  if (ra !== rb) {
    if (ra === null) return 1;
    if (rb === null) return -1;
    if (ra < rb) return -1;
    if (ra > rb) return 1;
  }
  return a.id - b.id;
}

export function buildBacklogTree(
  items: readonly BacklogItem[],
  options: { showClosed: boolean },
): BacklogTree {
  const byId = new Map<number, BacklogItem>();
  for (const item of items) byId.set(item.id, item);

  // Parent cycles in bad data are broken once, up front: at an Epic on the
  // cycle when there is one (so the Epic stays at the top level), otherwise at
  // the cycle's first item in backlog order, which becomes a root.
  const brokenAt = new Set<number>();
  const rawParentOf = (item: BacklogItem): BacklogItem | null => {
    if (item.parentId === null || item.parentId === item.id) return null;
    return byId.get(item.parentId) ?? null;
  };
  const walkState = new Map<number, "walking" | "done">();
  for (const start of items) {
    if (walkState.has(start.id)) continue;
    const path: BacklogItem[] = [];
    let current: BacklogItem | null = start;
    while (current && !walkState.has(current.id)) {
      walkState.set(current.id, "walking");
      path.push(current);
      current = rawParentOf(current);
    }
    if (current && walkState.get(current.id) === "walking") {
      const cycle = path.slice(path.indexOf(current));
      const epicsOnCycle = cycle.filter(isEpic).sort(compareBacklogItems);
      brokenAt.add((epicsOnCycle[0] ?? [...cycle].sort(compareBacklogItems)[0]!).id);
    }
    for (const item of path) walkState.set(item.id, "done");
  }

  /** The tree parent: null when missing from the cache, self-referencing or where a cycle is broken. */
  const parentOf = (item: BacklogItem): BacklogItem | null =>
    brokenAt.has(item.id) ? null : rawParentOf(item);

  // Does the chain strictly above this item contain an Epic? Memoized. The
  // chain is acyclic once cycles are broken; the guard only protects against
  // a mistake here turning into an endless loop.
  const epicAbove = new Map<number, boolean>();
  const resolving = new Set<number>();
  const resolveEpicAbove = (item: BacklogItem): boolean => {
    const known = epicAbove.get(item.id);
    if (known !== undefined) return known;
    if (resolving.has(item.id)) return false;
    resolving.add(item.id);
    const parent = parentOf(item);
    const value = parent ? isEpic(parent) || resolveEpicAbove(parent) : false;
    resolving.delete(item.id);
    epicAbove.set(item.id, value);
    return value;
  };
  for (const item of items) resolveEpicAbove(item);

  // A node starts a tree when it has no parent, or when it is an Epic with no
  // Epic above it (lifted out of a non-Epic parent).
  const isTopEpic = (item: BacklogItem) => isEpic(item) && !epicAbove.get(item.id);
  const childrenOf = new Map<number, BacklogItem[]>();
  const epicRoots: BacklogItem[] = [];
  const noEpicRoots: BacklogItem[] = [];
  for (const item of items) {
    const parent = parentOf(item);
    if (isTopEpic(item)) {
      epicRoots.push(item);
      continue;
    }
    if (parent) {
      const siblings = childrenOf.get(parent.id);
      if (siblings) siblings.push(item);
      else childrenOf.set(parent.id, [item]);
      continue;
    }
    // No parent and not an Epic: it has no Epic in its chain.
    noEpicRoots.push(item);
  }

  let visibleCount = 0;
  let hiddenClosedCount = 0;
  const visited = new Set<number>();

  const build = (item: BacklogItem, depth: number, treeParentId: number | null): BacklogTreeNode | null => {
    if (visited.has(item.id)) return null;
    visited.add(item.id);
    const childItems = [...(childrenOf.get(item.id) ?? [])].sort(compareBacklogItems);
    const children = buildSiblings(childItems, depth + 1, item.id);
    const closed = isClosedBacklogItem(item);
    if (closed && !options.showClosed && children.length === 0) {
      hiddenClosedCount += 1;
      return null;
    }
    visibleCount += 1;
    let descendantCount = 0;
    for (const child of children) descendantCount += 1 + child.descendantCount;
    return {
      item,
      depth,
      treeParentId,
      posInSet: 0,
      setSize: 0,
      children,
      closed,
      contextOnly: closed && !options.showClosed,
      descendantCount,
    };
  };

  function buildSiblings(sorted: BacklogItem[], depth: number, treeParentId: number | null): BacklogTreeNode[] {
    const nodes: BacklogTreeNode[] = [];
    for (const sibling of sorted) {
      const node = build(sibling, depth, treeParentId);
      if (node) nodes.push(node);
    }
    nodes.forEach((node, index) => {
      node.posInSet = index + 1;
      node.setSize = nodes.length;
    });
    return nodes;
  }

  const epics = buildSiblings([...epicRoots].sort(compareBacklogItems), 0, null);
  const noEpic = buildSiblings([...noEpicRoots].sort(compareBacklogItems), 0, null);

  return { epics, noEpic, visibleCount, hiddenClosedCount };
}

/** Flattens the tree into rows in display order, skipping collapsed subtrees. */
export function flattenBacklogTree(
  nodes: readonly BacklogTreeNode[],
  collapsed: ReadonlySet<number>,
): BacklogTreeNode[] {
  const rows: BacklogTreeNode[] = [];
  const walk = (list: readonly BacklogTreeNode[]) => {
    for (const node of list) {
      rows.push(node);
      if (node.children.length > 0 && !collapsed.has(node.item.id)) walk(node.children);
    }
  };
  walk(nodes);
  return rows;
}
