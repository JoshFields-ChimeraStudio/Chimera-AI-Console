import { StatusBadge } from "../StatusBadge";
import { stateCategoryBadgeStatus } from "../../lib/backlog/work-item-types";

/** An ADO state, coloured by its state category with the task status palette. */
export function WorkItemStateBadge({
  state,
  stateCategory,
  className,
}: {
  state: string;
  stateCategory: string | null;
  className?: string;
}) {
  return (
    <StatusBadge
      status={stateCategoryBadgeStatus(stateCategory)}
      label={state}
      className={className}
    />
  );
}
