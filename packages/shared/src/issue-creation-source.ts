/**
 * Fork patch (Chimera): plugin origins that only link an ordinary task to an
 * external item (an ADO work item). Such a task stays an ordinary task: it keeps
 * its creator classification and is not treated as plugin-managed by recovery.
 */
export const LINKED_TASK_ORIGIN_KINDS = ["plugin:chimera.plugin-ado:workitem"] as const;

export function isLinkedTaskOriginKind(originKind: string | null | undefined): boolean {
  return (LINKED_TASK_ORIGIN_KINDS as readonly string[]).includes(originKind ?? "");
}

/** Origins that represent a person's ordinary task or onboarding request. */
export const HUMAN_TASK_ORIGIN_KINDS = ["manual", "onboarding_first_task", ...LINKED_TASK_ORIGIN_KINDS] as const;

export interface IssueCreationSourceFields {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  originKind?: string | null;
}

/** Creation is independent of who is assigned or responsible for execution. */
export function isAgentCreatedIssue(issue: IssueCreationSourceFields): boolean {
  return Boolean(issue.createdByAgentId)
    || !issue.createdByUserId
    || !HUMAN_TASK_ORIGIN_KINDS.includes(
      (issue.originKind ?? "manual") as typeof HUMAN_TASK_ORIGIN_KINDS[number],
    );
}
