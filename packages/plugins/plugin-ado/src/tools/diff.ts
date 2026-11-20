/**
 * A small line diff for ado_get_pr_changes (A8): reviewers read a pull request's changes through
 * the plugin instead of the ADO MCP. Unified format with 3 lines of context, from a longest-common-
 * subsequence table; files over MAX_DIFF_LINES lines are not diffed (the tool gives both versions'
 * sizes and the reviewer reads the file with ado_get_file instead).
 */

export const MAX_DIFF_LINES = 3000;
const CONTEXT = 3;

type Op = { kind: " " | "-" | "+"; line: string; a: number; b: number };

function lines(text: string): string[] {
  if (text === "") return [];
  const out = text.replace(/\r\n/g, "\n").split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

/** The unified diff of two texts, or null when either is too long to diff. "" when they are the same. */
export function unifiedDiff(before: string, after: string, path: string): string | null {
  const a = lines(before);
  const b = lines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  // Strip the common head and tail first: most changes are small, so the table stays small.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const n = am.length;
  const m = bm.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) table[i]![j] = am[i] === bm[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const ops: Op[] = [];
  for (let k = 0; k < head; k++) ops.push({ kind: " ", line: a[k]!, a: k, b: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      ops.push({ kind: " ", line: am[i]!, a: head + i, b: head + j });
      i++;
      j++;
    } else if (i < n && (j >= m || table[i + 1]![j]! >= table[i]![j + 1]!)) {
      // Removed lines before added ones, as diff tools show them.
      ops.push({ kind: "-", line: am[i]!, a: head + i, b: head + j });
      i++;
    } else {
      ops.push({ kind: "+", line: bm[j]!, a: head + i, b: head + j });
      j++;
    }
  }
  for (let k = 0; k < tail; k++) ops.push({ kind: " ", line: a[a.length - tail + k]!, a: a.length - tail + k, b: b.length - tail + k });
  if (!ops.some((o) => o.kind !== " ")) return "";

  const out = [`--- a${path}`, `+++ b${path}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.kind === " ") {
      k++;
      continue;
    }
    // A hunk: from CONTEXT lines before this change to CONTEXT lines after the last change near it.
    const start = Math.max(0, k - CONTEXT);
    let end = k;
    let quiet = 0;
    for (let x = k; x < ops.length; x++) {
      if (ops[x]!.kind === " ") {
        quiet++;
        if (quiet > CONTEXT * 2) break;
      } else {
        quiet = 0;
        end = x;
      }
    }
    const stop = Math.min(ops.length, end + CONTEXT + 1);
    const hunk = ops.slice(start, stop);
    const aStart = hunk[0]!.a;
    const bStart = hunk[0]!.b;
    const aLen = hunk.filter((o) => o.kind !== "+").length;
    const bLen = hunk.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const o of hunk) out.push(`${o.kind}${o.line}`);
    k = stop;
  }
  return out.join("\n");
}
