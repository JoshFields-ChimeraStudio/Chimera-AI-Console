import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, Issue } from "@paperclipai/shared";
import { activityApi } from "../../api/activity";
import { heartbeatsApi } from "../../api/heartbeats";
import { issuesApi } from "../../api/issues";
import { useTaskDetailInterfaceMode } from "../../hooks/useTaskDetailInterfaceMode";
import { getIssueDetailQueryOptions } from "../../lib/issueDetailCache";
import { resolveIssueActiveRun } from "../../lib/issueActiveRun";
import { extractIssueTimelineEvents } from "../../lib/issue-timeline-events";
import { queryKeys } from "../../lib/queryKeys";
import { EmailThreadProvider } from "../EmailMessageCard";
import { IssueChatThread } from "../IssueChatThread";
import { IssueRunLedger } from "../IssueRunLedger";
import { QueryErrorState, useQueryView } from "../QueryView";
import { TaskChatThread } from "../TaskChatThread";
import { Skeleton } from "@/components/ui/skeleton";

/** Latest comments shown; the full history is on the task page. */
const COMMENT_WINDOW = 100;
const LIVE_POLL_MS = 3000;
const EMPTY_CHILD_ISSUES: Issue[] = [];
const handleReadOnlyAdd = async () => {};

/**
 * The linked task's conversation and runs, drawn with the task page's own
 * components: the same thread component the task page picks
 * (`TaskChatThread`, or `IssueChatThread` with the classic task interface),
 * and `IssueRunLedger`. Read-only: replying, steering and run controls stay on
 * the task page, which this section links to.
 *
 * The data reads reuse the task page's query keys (detail, runs, live runs,
 * active run, recent activity), so both views share one cache. Comments use a
 * key of their own because the task page keeps its comments as paged history.
 */
export function LinkedTaskAgentOutput({
  issueId,
  companyId,
  agentMap,
}: {
  issueId: string;
  companyId: string;
  agentMap: Map<string, Agent>;
}) {
  const queryClient = useQueryClient();
  const { classicTaskInterfaceEnabled } = useTaskDetailInterfaceMode();
  const ThreadComponent = classicTaskInterfaceEnabled ? IssueChatThread : TaskChatThread;

  const issueQuery = useQuery({
    ...getIssueDetailQueryOptions(queryClient, issueId),
    refetchInterval: (query) => ((query.state.data as Issue | undefined)?.status === "in_progress" ? LIVE_POLL_MS : false),
  });
  const issueView = useQueryView(issueQuery);
  const issue = issueQuery.data;
  const issueStatus = issue?.status ?? "todo";

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    refetchInterval: LIVE_POLL_MS,
  });
  const { data: activeRun = null } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId),
    enabled: issueStatus === "in_progress" || !!issue?.executionRunId,
    refetchInterval: LIVE_POLL_MS,
  });
  const resolvedActiveRun = useMemo(
    () => (issue ? resolveIssueActiveRun(issue, activeRun, liveRuns) : null),
    [issue, activeRun, liveRuns],
  );
  const hasLiveRuns = (liveRuns?.length ?? 0) > 0 || !!resolvedActiveRun;

  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    refetchInterval: hasLiveRuns || issueStatus === "in_progress" ? LIVE_POLL_MS : false,
  });
  const { data: comments, isLoading: commentsLoading } = useQuery({
    queryKey: [...queryKeys.issues.comments(issueId), "backlog-output"],
    queryFn: async () => {
      const latest = await issuesApi.listComments(issueId, { order: "desc", limit: COMMENT_WINDOW });
      return [...latest].reverse();
    },
    refetchInterval: hasLiveRuns || issueStatus === "in_progress" ? LIVE_POLL_MS : false,
  });
  const { data: activity } = useQuery({
    queryKey: [...queryKeys.issues.activity(issueId), "recent"],
    queryFn: () => activityApi.recentForIssue(issueId),
    refetchInterval: hasLiveRuns ? LIVE_POLL_MS : false,
  });

  // As on the task page: live runs render from the live list, the rest from history.
  const timelineRuns = useMemo(() => {
    const liveIds = new Set<string>((liveRuns ?? []).map((run) => run.id));
    if (resolvedActiveRun) liveIds.add(resolvedActiveRun.id);
    return (runs ?? [])
      .filter((run) => !liveIds.has(run.runId))
      .map((run) => ({ ...run, hasStoredOutput: (run.logBytes ?? 0) > 0 }));
  }, [runs, liveRuns, resolvedActiveRun]);
  const timelineEvents = useMemo(() => extractIssueTimelineEvents(activity ?? []), [activity]);

  if (issueView.kind === "loading" || issueView.kind === "reconnecting") {
    return <Skeleton className="h-24 w-full" />;
  }
  if (issueView.kind === "error" || !issue) {
    return (
      <QueryErrorState
        error={issueView.error}
        action="load the linked task"
        onRetry={issueView.retry}
        retrying={issueView.isFetching}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="linked-task-agent-output">
      {commentsLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <EmailThreadProvider companyId={companyId} issueId={issue.id}>
          <ThreadComponent
            comments={comments ?? []}
            linkedRuns={timelineRuns}
            liveRuns={liveRuns ?? []}
            activeRun={resolvedActiveRun}
            timelineEvents={timelineEvents}
            issueId={issue.id}
            companyId={companyId}
            projectId={issue.projectId ?? null}
            issueStatus={issue.status}
            issueAssigneeAgentId={issue.assigneeAgentId ?? null}
            agentMap={agentMap}
            onAdd={handleReadOnlyAdd}
            showComposer={false}
            showJumpToLatest={false}
            variant="embedded"
            emptyMessage="No conversation yet. The agent's replies and runs appear here."
          />
        </EmailThreadProvider>
      )}
      <IssueRunLedger
        issueId={issue.id}
        companyId={companyId}
        issueStatus={issue.status}
        childIssues={EMPTY_CHILD_ISSUES}
        agentMap={agentMap}
        hasLiveRuns={hasLiveRuns}
        activityEvents={activity ?? []}
      />
    </div>
  );
}
