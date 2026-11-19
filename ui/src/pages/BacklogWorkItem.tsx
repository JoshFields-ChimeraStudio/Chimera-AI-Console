import { useEffect, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, GitPullRequest, ListTree, RotateCw } from "lucide-react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { agentsApi } from "../api/agents";
import { isPluginUnavailableError, isWorkItemNotFoundError } from "../api/backlog";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useAdoPlugin, useBacklogLiveUpdates, useWorkItem } from "../hooks/useBacklog";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime } from "../lib/utils";
import { safeExternalHref } from "../lib/backlog/work-item-types";
import type { WorkItemDetail, WorkItemRelated } from "../lib/backlog/contract";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { PageSkeleton } from "../components/PageSkeleton";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { WorkItemTypeIcon } from "../components/backlog/WorkItemTypeIcon";
import { WorkItemStateBadge } from "../components/backlog/WorkItemStateBadge";
import { WorkItemAssignControl } from "../components/backlog/WorkItemAssignControl";
import { LinkedTaskAgentOutput } from "../components/backlog/LinkedTaskAgentOutput";
import { backlogWorkItemPath } from "../components/backlog/BacklogRow";

const BACKLOG_PATH = "/backlog";

export function parseWorkItemId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/**
 * ADO text fields arrive as Markdown converted by the plugin. They render
 * through the console's Markdown component only (which never renders raw
 * HTML), with images and diagrams kept as inert references: ADO attachment
 * URLs need ADO sign-in and must not be fetched from the console.
 */
function WorkItemMarkdown({ markdown, emptyText }: { markdown: string | null; emptyText: string }) {
  if (!markdown || markdown.trim().length === 0) return <Muted>{emptyText}</Muted>;
  return (
    <MarkdownBody className="text-sm" mediaMode="reference" linkIssueReferences={false}>
      {markdown}
    </MarkdownBody>
  );
}

const RELATION_ORDER: Array<{ key: string; title: string }> = [
  { key: "Parent", title: "Parent" },
  { key: "Child", title: "Children" },
  { key: "Related", title: "Related" },
];

function RelatedItems({ related }: { related: WorkItemRelated[] }) {
  if (related.length === 0) return <Muted>No related work items.</Muted>;
  const known = new Set(RELATION_ORDER.map((entry) => entry.key));
  const groups = [
    ...RELATION_ORDER.map((entry) => ({ title: entry.title, items: related.filter((item) => item.relation === entry.key) })),
    { title: "Other links", items: related.filter((item) => !known.has(item.relation)) },
  ].filter((group) => group.items.length > 0);
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <div key={group.title} className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.title}</span>
          <ul className="flex flex-col">
            {group.items.map((item) => (
              <li key={`${item.relation}:${item.id}`}>
                <Link
                  to={backlogWorkItemPath(item.id)}
                  className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-sm no-underline text-inherit hover:bg-accent/50"
                >
                  <WorkItemTypeIcon type={item.type} typeColor={null} />
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.id}</span>
                  <span className="min-w-0 flex-1 truncate">{item.title ?? `Work item ${item.id}`}</span>
                  {group.title === "Other links" ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{item.relation}</span>
                  ) : null}
                  {item.state ? <WorkItemStateBadge state={item.state} stateCategory={null} /> : null}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function PullRequests({ pullRequests }: { pullRequests: WorkItemDetail["pullRequests"] }) {
  if (pullRequests.length === 0) return <Muted>No pull requests.</Muted>;
  return (
    <ul className="flex flex-col gap-1">
      {pullRequests.map((pr) => {
        const href = safeExternalHref(pr.url);
        const label = (
          <>
            <GitPullRequest className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="shrink-0 font-mono text-xs text-muted-foreground">!{pr.id}</span>
            <span className="min-w-0 flex-1 truncate">{pr.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {pr.repository} · {pr.status}
            </span>
          </>
        );
        return (
          <li key={pr.id}>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-sm no-underline text-inherit hover:bg-accent/50"
              >
                {label}
              </a>
            ) : (
              <span className="flex items-center gap-2 px-1 py-1.5 text-sm">{label}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Comments({ comments }: { comments: WorkItemDetail["comments"] }) {
  if (comments.length === 0) return <Muted>No comments.</Muted>;
  return (
    <ol className="flex flex-col gap-3">
      {comments.map((comment) => (
        <li key={comment.id} className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2">
          <span className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{comment.author}</span>
            {" · "}
            <time dateTime={comment.createdDate}>{formatDateTime(comment.createdDate)}</time>
          </span>
          <WorkItemMarkdown markdown={comment.markdown} emptyText="(empty comment)" />
        </li>
      ))}
    </ol>
  );
}

export function BacklogWorkItem() {
  const params = useParams<{ workItemId: string }>();
  const workItemId = parseWorkItemId(params.workItemId);
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { plugin, pluginId, isLoading: pluginLoading } = useAdoPlugin();
  const workItemQuery = useWorkItem(pluginId, selectedCompanyId, workItemId);
  // Re-reads this work item from ADO when the plugin reports a change to it.
  useBacklogLiveUpdates(pluginId, selectedCompanyId, workItemId);
  const workItemView = useQueryView(workItemQuery);
  const workItem = workItemQuery.data;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const agentMap = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Backlog", href: BACKLOG_PATH },
      {
        label: workItem?.title ?? (workItemId !== null ? `Work item ${workItemId}` : "Work item"),
        identifier: workItemId !== null ? String(workItemId) : undefined,
      },
    ]);
  }, [setBreadcrumbs, workItem?.title, workItemId]);

  const backToBacklog = () => navigate(BACKLOG_PATH);

  if (workItemId === null) {
    return (
      <EmptyState
        icon={ListTree}
        message="This is not a work item ID."
        action="Back to Backlog"
        hideActionIcon
        onAction={backToBacklog}
      />
    );
  }
  if (!selectedCompanyId) {
    return <EmptyState icon={ListTree} message="Select a company to view this work item." />;
  }
  if (pluginLoading) return <PageSkeleton variant="detail" />;
  if (!plugin || !pluginId || (!workItem && isPluginUnavailableError(workItemView.error))) {
    return (
      <EmptyState
        icon={ListTree}
        title="Azure DevOps is not available"
        message="Work items need the Azure DevOps plugin installed and running."
        action="Back to Backlog"
        hideActionIcon
        onAction={backToBacklog}
      />
    );
  }
  if (!workItem && (workItemView.kind === "loading" || workItemView.kind === "reconnecting")) {
    return <PageSkeleton variant="detail" />;
  }
  if (!workItem) {
    if (isWorkItemNotFoundError(workItemView.error)) {
      return (
        <EmptyState
          icon={ListTree}
          title="Not found in Azure DevOps"
          message={
            workItemView.error instanceof Error
              ? workItemView.error.message
              : `Work item ${workItemId} no longer exists in Azure DevOps.`
          }
          description="It may have been deleted or moved to another project. The next sync removes it from the Backlog."
          action="Back to Backlog"
          hideActionIcon
          onAction={backToBacklog}
        />
      );
    }
    return (
      <QueryErrorState
        size="page"
        error={workItemView.error}
        action={`load work item ${workItemId}`}
        onRetry={workItemView.retry}
        retrying={workItemView.isFetching}
      />
    );
  }

  const adoHref = safeExternalHref(workItem.url);
  // Loaded data stays on screen; a real refresh failure shows inline above it.
  const refreshError = workItemView.kind === "error" ? workItemView.error : null;

  return (
    <div className="flex max-w-4xl flex-col gap-6" data-testid="backlog-work-item">
      {refreshError ? (
        <QueryErrorState
          size="inline"
          error={refreshError}
          action={`refresh work item ${workItemId}`}
          onRetry={workItemView.retry}
          retrying={workItemView.isFetching}
        />
      ) : null}
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <WorkItemTypeIcon type={workItem.type} typeColor={workItem.typeColor} />
          <span className="text-xs uppercase text-muted-foreground">{workItem.type}</span>
          {adoHref ? (
            <a
              href={adoHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              title="Open in Azure DevOps"
            >
              {workItem.id}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">{workItem.id}</span>
          )}
          <WorkItemStateBadge state={workItem.state} stateCategory={workItem.stateCategory} />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => void workItemQuery.refetch()}
            disabled={workItemQuery.isFetching}
            title="Re-read this work item from Azure DevOps"
          >
            <RotateCw className={`h-3.5 w-3.5${workItemQuery.isFetching ? " animate-spin" : ""}`} aria-hidden />
            Refresh
          </Button>
        </div>
        <h2 className="text-xl font-bold">{workItem.title}</h2>
        <WorkItemAssignControl
          pluginId={pluginId}
          companyId={selectedCompanyId}
          workItemId={workItem.id}
          linkedTask={workItem.linkedTask}
          agents={agents ?? []}
        />
      </header>

      <Section title="Description">
        <WorkItemMarkdown markdown={workItem.descriptionMarkdown} emptyText="No description." />
      </Section>
      <Section title="Acceptance criteria">
        <WorkItemMarkdown markdown={workItem.acceptanceCriteriaMarkdown} emptyText="No acceptance criteria." />
      </Section>
      <Section title="Technical notes">
        <WorkItemMarkdown markdown={workItem.technicalNotesMarkdown} emptyText="No technical notes." />
      </Section>
      <Section title="Pull requests">
        <PullRequests pullRequests={workItem.pullRequests} />
      </Section>
      <Section title="Related work items">
        <RelatedItems related={workItem.related} />
      </Section>
      <Section title="Comments">
        <Comments comments={workItem.comments} />
      </Section>
      <Section title="Agent output">
        {workItem.linkedTask ? (
          <LinkedTaskAgentOutput
            issueId={workItem.linkedTask.issueId}
            companyId={selectedCompanyId}
            agentMap={agentMap}
          />
        ) : (
          <Muted>No agent is working on this yet. Assign an agent to start.</Muted>
        )}
      </Section>
    </div>
  );
}
