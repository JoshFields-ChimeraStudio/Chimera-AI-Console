import { Bug, Crown, SquareDot } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  normalizeTypeColor,
  safeExternalHref,
  stateCategoryBadgeStatus,
  workItemTypeVisual,
} from "./work-item-types";

describe("workItemTypeVisual", () => {
  it("maps known ADO types to icons, preferring the plugin's typeColor", () => {
    expect(workItemTypeVisual("Epic", "#123456")).toEqual({ icon: Crown, color: "#123456", known: true });
    expect(workItemTypeVisual("defect", null)).toEqual({ icon: Bug, color: "#CC293D", known: true });
  });

  it("falls back to ADO's standard colour when typeColor is missing or invalid", () => {
    expect(workItemTypeVisual("Epic", null).color).toBe("#FF7B00");
    expect(workItemTypeVisual("Epic", "red; background: url(x)").color).toBe("#FF7B00");
  });

  it("gives unknown types a generic icon with their typeColor", () => {
    expect(workItemTypeVisual("Risk", "ab12cd")).toEqual({ icon: SquareDot, color: "#AB12CD", known: false });
    expect(workItemTypeVisual(null, null).icon).toBe(SquareDot);
  });
});

describe("normalizeTypeColor", () => {
  it("accepts hex with or without #", () => {
    expect(normalizeTypeColor("ff7b00")).toBe("#FF7B00");
    expect(normalizeTypeColor(" #abc ")).toBe("#ABC");
    expect(normalizeTypeColor("#zzzzzz")).toBeNull();
    expect(normalizeTypeColor("")).toBeNull();
  });
});

describe("stateCategoryBadgeStatus", () => {
  it("maps ADO state categories to the task status palette", () => {
    expect(stateCategoryBadgeStatus("InProgress")).toBe("in_progress");
    expect(stateCategoryBadgeStatus("Completed")).toBe("done");
    expect(stateCategoryBadgeStatus(null)).toBe("unknown");
  });
});

describe("safeExternalHref", () => {
  it("only links http(s) URLs", () => {
    expect(safeExternalHref("https://dev.azure.com/org/p/_workitems/edit/1")).toBe(
      "https://dev.azure.com/org/p/_workitems/edit/1",
    );
    expect(safeExternalHref("javascript:alert(1)")).toBeNull();
    expect(safeExternalHref("not a url")).toBeNull();
    expect(safeExternalHref(null)).toBeNull();
  });
});
