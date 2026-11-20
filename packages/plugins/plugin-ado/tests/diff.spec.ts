import { describe, expect, it } from "vitest";
import { MAX_DIFF_LINES, unifiedDiff } from "../src/tools/diff.js";

describe("unifiedDiff (A8)", () => {
  it("gives hunks with three lines of context, and nothing for equal texts", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const after = before.replace("line 10", "line ten").replace("line 20", "line 20\nline 21");
    expect(unifiedDiff(before, after, "/f.txt")).toBe(
      [
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -7,7 +7,7 @@",
        " line 7",
        " line 8",
        " line 9",
        "-line 10",
        "+line ten",
        " line 11",
        " line 12",
        " line 13",
        "@@ -18,3 +18,4 @@",
        " line 18",
        " line 19",
        " line 20",
        "+line 21",
      ].join("\n"),
    );
    expect(unifiedDiff("a\nb\n", "a\r\nb\r\n", "/x")).toBe("");
    expect(unifiedDiff("", "new\n", "/n")).toBe("--- a/n\n+++ b/n\n@@ -0,0 +1,1 @@\n+new");
    expect(unifiedDiff("old\n", "", "/d")).toBe("--- a/d\n+++ b/d\n@@ -1,1 +0,0 @@\n-old");
  });

  it("does not diff very long files", () => {
    const long = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => String(i)).join("\n");
    expect(unifiedDiff(long, "x", "/l")).toBeNull();
  });
});
