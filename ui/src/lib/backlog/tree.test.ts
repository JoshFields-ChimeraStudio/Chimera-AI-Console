import { describe, expect, it } from "vitest";
import type { BacklogItem, BacklogStateCategory } from "./contract";
import { buildBacklogTree, flattenBacklogTree, type BacklogTreeNode } from "./tree";

function item(
  id: number,
  type: string,
  parentId: number | null,
  options: { stackRank?: number | null; stateCategory?: BacklogStateCategory | null } = {},
): BacklogItem {
  return {
    id,
    parentId,
    type,
    typeColor: null,
    title: `${type} ${id}`,
    state: options.stateCategory === "Completed" ? "Closed" : "New",
    stateCategory: options.stateCategory === undefined ? "Proposed" : options.stateCategory,
    stackRank: options.stackRank === undefined ? null : options.stackRank,
    url: `https://dev.azure.com/org/project/_workitems/edit/${id}`,
    linkedTask: null,
  };
}

const ids = (nodes: readonly BacklogTreeNode[]) => nodes.map((node) => node.item.id);
const shape = (nodes: readonly BacklogTreeNode[]): unknown =>
  nodes.map((node) => (node.children.length ? [node.item.id, shape(node.children)] : node.item.id));

describe("buildBacklogTree", () => {
  it("puts Epics at the top level and nests children by parentId", () => {
    const tree = buildBacklogTree(
      [
        item(10, "Task", 3),
        item(1, "Epic", null),
        item(2, "Feature", 1),
        item(3, "User Story", 2),
        item(4, "Documentation", 2),
      ],
      { showClosed: false },
    );
    expect(shape(tree.epics)).toEqual([[1, [[2, [[3, [10]], 4]]]]]);
    expect(tree.noEpic).toEqual([]);
    expect(tree.epics[0]!.descendantCount).toBe(4);
    expect(tree.epics[0]!.children[0]!.children[0]!.children[0]!.depth).toBe(3);
  });

  it("orders siblings by stackRank, missing ranks last, then by id", () => {
    const tree = buildBacklogTree(
      [
        item(5, "Epic", null, { stackRank: 2 }),
        item(4, "Epic", null, { stackRank: 1 }),
        item(3, "Epic", null),
        item(2, "Epic", null),
        item(6, "Epic", null, { stackRank: 1 }),
        item(20, "Feature", 4, { stackRank: 9.5 }),
        item(21, "Feature", 4, { stackRank: 1.25 }),
      ],
      { showClosed: false },
    );
    expect(ids(tree.epics)).toEqual([4, 6, 5, 2, 3]);
    expect(ids(tree.epics[0]!.children)).toEqual([21, 20]);
  });

  it("groups items with no Epic in their ancestor chain under Not under an Epic, still as a tree", () => {
    const tree = buildBacklogTree(
      [
        item(1, "Epic", null),
        item(2, "Feature", 1),
        item(30, "Bug", null, { stackRank: 2 }),
        item(31, "Feature", null, { stackRank: 1 }),
        item(32, "User Story", 31),
        item(33, "Task", 32),
        // Parent not in the cache: treated as a root.
        item(34, "User Story", 999, { stackRank: 3 }),
      ],
      { showClosed: false },
    );
    expect(shape(tree.epics)).toEqual([[1, [2]]]);
    expect(shape(tree.noEpic)).toEqual([[31, [[32, [33]]]], 30, 34]);
  });

  it("lifts an Epic below a non-Epic parent to the top level", () => {
    const tree = buildBacklogTree(
      [item(1, "Theme", null), item(2, "Epic", 1), item(3, "Feature", 2), item(4, "Feature", 1)],
      { showClosed: false },
    );
    expect(shape(tree.epics)).toEqual([[2, [3]]]);
    expect(shape(tree.noEpic)).toEqual([[1, [4]]]);
  });

  it("keeps an Epic under another Epic nested", () => {
    const tree = buildBacklogTree([item(1, "Epic", null), item(2, "epic", 1)], { showClosed: false });
    expect(shape(tree.epics)).toEqual([[1, [2]]]);
  });

  it("hides Completed and Removed items by default and shows them with Show closed", () => {
    const items = [
      item(1, "Epic", null),
      item(2, "Feature", 1, { stateCategory: "Completed" }),
      item(3, "Feature", 1, { stateCategory: "Removed" }),
      item(4, "Feature", 1, { stateCategory: "Resolved" }),
      item(5, "Bug", null, { stateCategory: "Completed" }),
    ];
    const hidden = buildBacklogTree(items, { showClosed: false });
    expect(shape(hidden.epics)).toEqual([[1, [4]]]);
    expect(hidden.noEpic).toEqual([]);
    expect(hidden.hiddenClosedCount).toBe(3);
    expect(hidden.visibleCount).toBe(2);

    const shown = buildBacklogTree(items, { showClosed: true });
    expect(shape(shown.epics)).toEqual([[1, [2, 3, 4]]]);
    expect(ids(shown.noEpic)).toEqual([5]);
    expect(shown.hiddenClosedCount).toBe(0);
    expect(shown.epics[0]!.children[0]!.closed).toBe(true);
    expect(shown.epics[0]!.children[0]!.contextOnly).toBe(false);
  });

  it("keeps a closed parent as a dimmed context row when an open child is visible", () => {
    const tree = buildBacklogTree(
      [
        item(1, "Epic", null, { stateCategory: "Completed" }),
        item(2, "Feature", 1, { stateCategory: "Completed" }),
        item(3, "User Story", 2),
        item(4, "Feature", 1, { stateCategory: "Completed" }),
      ],
      { showClosed: false },
    );
    expect(shape(tree.epics)).toEqual([[1, [[2, [3]]]]]);
    const epic = tree.epics[0]!;
    expect(epic.contextOnly).toBe(true);
    expect(epic.children[0]!.contextOnly).toBe(true);
    expect(epic.children[0]!.children[0]!.contextOnly).toBe(false);
    expect(tree.hiddenClosedCount).toBe(1);
  });

  it("breaks a parent cycle at the Epic, keeping it at the top level", () => {
    const tree = buildBacklogTree(
      [item(1, "Feature", 2), item(2, "Epic", 3), item(3, "User Story", 1), item(4, "Task", 3)],
      { showClosed: false },
    );
    // 1 -> 2 (Epic) -> 3 -> 1: the cycle breaks above the Epic.
    expect(shape(tree.epics)).toEqual([[2, [[1, [[3, [4]]]]]]]);
    expect(tree.noEpic).toEqual([]);
  });

  it("never loops on parent cycles and still shows the items", () => {
    const tree = buildBacklogTree(
      [item(1, "Feature", 2), item(2, "User Story", 1), item(3, "Task", 3)],
      { showClosed: false },
    );
    const all = flattenBacklogTree([...tree.epics, ...tree.noEpic], new Set()).map((node) => node.item.id);
    expect(all.sort()).toEqual([1, 2, 3]);
    // No Epic on the cycle: it breaks at its first item, which becomes a root.
    expect(shape(tree.noEpic)).toEqual([[1, [2]], 3]);
  });

  it("records tree positions for assistive tech", () => {
    const tree = buildBacklogTree(
      [item(1, "Epic", null), item(2, "Feature", 1), item(3, "Feature", 1), item(4, "Epic", null)],
      { showClosed: false },
    );
    const [first, second] = tree.epics;
    expect([first!.posInSet, first!.setSize, second!.posInSet]).toEqual([1, 2, 2]);
    expect(first!.children.map((n) => [n.treeParentId, n.posInSet, n.setSize])).toEqual([[1, 1, 2], [1, 2, 2]]);
    expect(first!.treeParentId).toBeNull();
  });

  it("builds a realistic-size backlog in one pass", () => {
    const items: BacklogItem[] = [];
    let id = 1;
    for (let e = 0; e < 40; e += 1) {
      const epicId = id++;
      items.push(item(epicId, "Epic", null, { stackRank: e }));
      for (let f = 0; f < 10; f += 1) {
        const featureId = id++;
        items.push(item(featureId, "Feature", epicId, { stackRank: f }));
        for (let s = 0; s < 10; s += 1) {
          items.push(item(id++, "User Story", featureId, { stackRank: s, stateCategory: s % 3 === 0 ? "Completed" : "InProgress" }));
        }
      }
    }
    for (let b = 0; b < 500; b += 1) items.push(item(id++, "Bug", null, { stackRank: b }));

    const tree = buildBacklogTree(items, { showClosed: false });
    expect(tree.epics).toHaveLength(40);
    expect(tree.noEpic).toHaveLength(500);
    // 40 Epics + 400 Features + 2/3 of 4000 Stories (s = 1,2,4,5,7,8) + 500 Bugs.
    expect(tree.visibleCount).toBe(40 + 400 + 40 * 10 * 6 + 500);
    expect(tree.hiddenClosedCount).toBe(40 * 10 * 4);
  });
});

describe("flattenBacklogTree", () => {
  it("skips the subtrees of collapsed rows", () => {
    const tree = buildBacklogTree(
      [item(1, "Epic", null), item(2, "Feature", 1), item(3, "User Story", 2), item(4, "Epic", null)],
      { showClosed: false },
    );
    expect(flattenBacklogTree(tree.epics, new Set()).map((node) => node.item.id)).toEqual([1, 2, 3, 4]);
    expect(flattenBacklogTree(tree.epics, new Set([2])).map((node) => node.item.id)).toEqual([1, 2, 4]);
    expect(flattenBacklogTree(tree.epics, new Set([1])).map((node) => node.item.id)).toEqual([1, 4]);
  });
});
