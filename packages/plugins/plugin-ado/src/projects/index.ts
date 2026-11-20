/**
 * A12: which Paperclip project a new linked task goes in.
 *
 * A work item names its code repository with a "repo:<name>" tag (set through `repository` on
 * ado_create_work_item or ado_update_technical_notes, and copied to items created under it). The
 * task goes in the Paperclip project with a workspace on that repository (its repo URL ends in
 * /_git/<name>), or else the project named like the repository, so the agent gets that service's
 * worktree, CLAUDE.md and context. With no tag on the item or the items above it, or no project for
 * the repository, the task goes where it went before: its parent task's project.
 */
import type { Project } from "@paperclipai/plugin-sdk";
import type { AdoClient, AdoWorkItem } from "../ado/client.js";
import type { PluginDeps } from "../deps.js";

export const REPO_TAG_PREFIX = "repo:";
/** How far up the tree to look for a repo tag (Defect → Story → Feature → Epic is three). */
export const MAX_REPO_ANCESTORS = 5;

function splitTags(tags: unknown): string[] {
  return typeof tags === "string"
    ? tags
        .split(";")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
}

/** The repository named by an item's "repo:" tag, or null. */
export function repositoryOf(tags: unknown): string | null {
  const tag = splitTags(tags).find((t) => t.toLowerCase().startsWith(REPO_TAG_PREFIX));
  const name = tag?.slice(REPO_TAG_PREFIX.length).trim();
  return name || null;
}

/** The tags with any previous repo tag replaced (ADO tags cannot hold ";" or ","). */
export function withRepositoryTag(currentTags: unknown, repository: string): string {
  const kept = splitTags(currentTags).filter((t) => !t.toLowerCase().startsWith(REPO_TAG_PREFIX));
  const clean = repository.replace(/[;,]/g, " ").replace(/\s+/g, " ").trim();
  return [...kept, `${REPO_TAG_PREFIX}${clean}`].join("; ");
}

/** The repository of an item: its own tag, else the nearest item above it with one. */
export async function repositoryFor(ado: Pick<AdoClient, "getWorkItem">, item: AdoWorkItem): Promise<{ repository: string; fromId: number } | null> {
  let current: AdoWorkItem | null = item;
  const seen = new Set<number>();
  for (let depth = 0; current && depth <= MAX_REPO_ANCESTORS && !seen.has(current.id); depth++) {
    seen.add(current.id);
    const repository = repositoryOf(current.fields["System.Tags"]);
    if (repository) return { repository, fromId: current.id };
    const parentId: number = Number(current.fields["System.Parent"] ?? 0);
    current = parentId > 0 ? await ado.getWorkItem(parentId).catch(() => null) : null;
  }
  return null;
}

/** The repository name at the end of a repo URL (…/_git/<name>, or the last path part), lower case. */
export function repoNameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const path = url.replace(/[?#].*$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const git = path.match(/\/_git\/([^/]+)$/i);
  const name = git?.[1] ?? path.split(/[/:]/).pop();
  if (!name) return null;
  try {
    return decodeURIComponent(name).toLowerCase();
  } catch {
    return name.toLowerCase();
  }
}

/** The project for a repository: one with a workspace on it, else one named like it. */
export function projectForRepository(projects: Project[], repository: string): Project | null {
  const wanted = repository.trim().toLowerCase();
  const live = projects.filter((p) => !p.archivedAt);
  const byWorkspace = live.filter((p) => (p.workspaces ?? []).some((w) => repoNameFromUrl(w.repoUrl) === wanted));
  if (byWorkspace.length) return byWorkspace.find((p) => repoNameFromUrl(p.primaryWorkspace?.repoUrl) === wanted) ?? byWorkspace[0]!;
  return live.find((p) => p.name.trim().toLowerCase() === wanted) ?? null;
}

export interface ProjectChoice {
  /** The repository the item names (by its tag or an item above it), or null. */
  repository: string | null;
  /** The project for that repository, or null when there is none. */
  projectId: string | null;
  projectName: string | null;
}

export function createProjectRouter(deps: Pick<PluginDeps, "ctx">) {
  return {
    /** Where a new task for this item should go, by its repository; nulls when it names none or no project has it. */
    async choose(companyId: string, ado: Pick<AdoClient, "getWorkItem">, item: AdoWorkItem): Promise<ProjectChoice> {
      const found = await repositoryFor(ado, item);
      if (!found) return { repository: null, projectId: null, projectName: null };
      const projects = await deps.ctx.projects.list({ companyId, limit: 500 }).catch(() => [] as Project[]);
      const project = projectForRepository(projects, found.repository);
      return { repository: found.repository, projectId: project?.id ?? null, projectName: project?.name ?? null };
    },
  };
}

export type ProjectRouter = ReturnType<typeof createProjectRouter>;
