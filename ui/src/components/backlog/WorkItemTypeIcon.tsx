import { cn } from "../../lib/utils";
import { workItemTypeVisual } from "../../lib/backlog/work-item-types";

/** ADO work item type as an icon in the type's colour. */
export function WorkItemTypeIcon({
  type,
  typeColor,
  className,
}: {
  type: string | null;
  typeColor: string | null;
  className?: string;
}) {
  const { icon: Icon, color } = workItemTypeVisual(type, typeColor);
  const label = type ?? "Work item";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-work-item-type={type ?? undefined}
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
    >
      <Icon aria-hidden className="h-4 w-4" style={{ color }} />
    </span>
  );
}
