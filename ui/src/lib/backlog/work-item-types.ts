import {
  BookOpen,
  Bug,
  CircleAlert,
  ClipboardCheck,
  Crown,
  File,
  FileText,
  FlaskConical,
  SquareDot,
  Trophy,
  type LucideIcon,
} from "lucide-react";

/**
 * Work item type → icon, with ADO's standard type colour as the fallback when
 * the plugin sends no `typeColor`. These colours are data from Azure DevOps
 * (its default process colours), not console design values, so they live here
 * beside the mapping rather than in the token layer.
 */
interface WorkItemTypeVisual {
  icon: LucideIcon;
  color: string;
}

const KNOWN_TYPES: ReadonlyMap<string, WorkItemTypeVisual> = new Map(Object.entries({
  "epic": { icon: Crown, color: "#FF7B00" },
  "feature": { icon: Trophy, color: "#773B93" },
  "user story": { icon: BookOpen, color: "#009CCC" },
  "product backlog item": { icon: BookOpen, color: "#009CCC" },
  "requirement": { icon: BookOpen, color: "#009CCC" },
  "task": { icon: ClipboardCheck, color: "#F2CB1D" },
  "bug": { icon: Bug, color: "#CC293D" },
  "defect": { icon: Bug, color: "#CC293D" },
  "documentation": { icon: FileText, color: "#339947" },
  "document": { icon: File, color: "#339947" },
  "issue": { icon: CircleAlert, color: "#B4009E" },
  "impediment": { icon: CircleAlert, color: "#B4009E" },
  "test case": { icon: FlaskConical, color: "#004B50" },
} satisfies Record<string, WorkItemTypeVisual>));

/** ADO's colour for types it gives no colour of their own. */
const UNKNOWN_TYPE_COLOR = "#B2B2B2";

const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * A safe CSS colour from ADO's type colour: `#RGB`, `#RRGGBB` or `#RRGGBBAA`
 * (ADO's API often omits the `#`). Anything else is ignored.
 */
export function normalizeTypeColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = HEX_COLOR.exec(value.trim());
  return match ? `#${match[1]!.toUpperCase()}` : null;
}

export function workItemTypeVisual(
  type: string | null | undefined,
  typeColor: string | null | undefined,
): { icon: LucideIcon; color: string; known: boolean } {
  const known = type ? KNOWN_TYPES.get(type.trim().toLowerCase()) : undefined;
  return {
    icon: known?.icon ?? SquareDot,
    color: normalizeTypeColor(typeColor) ?? known?.color ?? UNKNOWN_TYPE_COLOR,
    known: Boolean(known),
  };
}

const STATE_CATEGORY_BADGE: Record<string, string> = {
  Proposed: "backlog",
  InProgress: "in_progress",
  Resolved: "in_review",
  Completed: "done",
  Removed: "cancelled",
};

/**
 * The console status whose badge colour matches an ADO state category, so an
 * ADO state reads with the same vocabulary as task states. The label stays the
 * ADO state name.
 */
export function stateCategoryBadgeStatus(stateCategory: string | null | undefined): string {
  return (stateCategory && Object.hasOwn(STATE_CATEGORY_BADGE, stateCategory) && STATE_CATEGORY_BADGE[stateCategory]) || "unknown";
}

/** An ADO link as an href, only for http(s) URLs; anything else is not linked. */
export function safeExternalHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
