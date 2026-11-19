import { useMemo } from "react";
import type { Agent } from "@paperclipai/shared";
import { Loader2 } from "lucide-react";
import { Link } from "@/lib/router";
import { describeError } from "../../api/errors";
import { useAssignAgent } from "../../hooks/useBacklog";
import { isAgentTaskTarget } from "../../lib/company-members";
import { createIssueDetailPath } from "../../lib/issueDetailBreadcrumb";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../../lib/recent-assignees";
import type { BacklogLinkedTask } from "../../lib/backlog/contract";
import { AgentAvatar } from "../AgentAvatar";
import { InlineEntitySelector } from "../InlineEntitySelector";
import { IssueStatusBadge } from "../StatusBadge";

/**
 * "Assign to agent": the same agent picker the task assignee uses
 * (`InlineEntitySelector` over the company's assignable agents, recent first),
 * with "Unassigned". Calls the plugin's `assign-agent`, which creates or reuses
 * the linked task; the task link and its status show beside the picker.
 */
export function WorkItemAssignControl({
  pluginId,
  companyId,
  workItemId,
  linkedTask,
  agents,
}: {
  pluginId: string;
  companyId: string;
  workItemId: number;
  linkedTask: BacklogLinkedTask | null;
  agents: readonly Agent[];
}) {
  const assign = useAssignAgent(pluginId, companyId);
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const options = useMemo(
    () =>
      sortAgentsByRecency(agents.filter(isAgentTaskTarget), getRecentAssigneeIds()).map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: agent.role ?? undefined,
      })),
    [agents],
  );
  const currentAgentId = linkedTask?.assigneeAgentId ?? "";
  const taskRef = linkedTask ? linkedTask.identifier ?? linkedTask.issueId : null;

  const renderAgent = (id: string | undefined, label: string) => {
    const agent = id ? agentById.get(id) : undefined;
    return (
      <>
        {agent ? <AgentAvatar agent={agent} size={16} className="h-4 w-4 shrink-0" /> : null}
        <span className="truncate">{label}</span>
      </>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">Assign to agent</span>
        <InlineEntitySelector
          value={currentAgentId}
          options={options}
          placeholder="Choose agent"
          noneLabel="Unassigned"
          searchPlaceholder="Search agents..."
          emptyMessage="No agents found."
          disabled={assign.isPending}
          triggerTestId="work-item-assign-agent"
          className="h-8 text-sm"
          onChange={(id) => {
            const agentId = id || null;
            if (agentId === (linkedTask?.assigneeAgentId ?? null)) return;
            if (agentId) trackRecentAssignee(agentId, companyId);
            assign.mutate({ workItemId, agentId });
          }}
          renderTriggerValue={(option) =>
            option ? renderAgent(option.id, option.label) : <span className="text-muted-foreground">Unassigned</span>
          }
          renderOption={(option) => renderAgent(option.id || undefined, option.label)}
        />
        {assign.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Assigning" /> : null}
        {taskRef && linkedTask ? (
          <span className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Task</span>
            <Link
              to={createIssueDetailPath(taskRef)}
              className="font-mono text-xs text-foreground underline-offset-2 hover:underline"
            >
              {taskRef}
            </Link>
            <IssueStatusBadge status={linkedTask.status} />
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No linked task yet. Choosing an agent creates one.</span>
        )}
      </div>
      {assign.error ? (
        <p role="alert" className="text-xs text-destructive">
          {describeError(assign.error, { action: "assign the agent" }).body}
        </p>
      ) : null}
      {assign.data?.created ? (
        <p role="status" className="text-xs text-muted-foreground">
          Created task {assign.data.identifier ?? assign.data.issueId}.
        </p>
      ) : null}
    </div>
  );
}
