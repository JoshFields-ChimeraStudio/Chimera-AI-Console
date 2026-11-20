import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { AdoClient } from "../src/ado/client.js";
import type { PluginDeps } from "../src/deps.js";
import type { AdoLink, LinkFeatures } from "../src/links/index.js";
import { countReviewRounds, registerAgentTools } from "../src/tools/index.js";
import { extractInstructions, instructionsToCarry, withInstructions } from "../src/workflow/instructions.js";
import { TOOL_DECLARATIONS, TOOL_NAMES } from "../src/tools/definitions.js";
import { attributedHtml, htmlToText, textToHtml } from "../src/tools/html.js";
import { ROLE_POLICIES, pruneBindings, resolveRole, type RoleBindings } from "../src/tools/roles.js";
import { createAdoPlugin } from "../src/worker.js";

const ORG = "https://dev.azure.com/ChimeraStudioSoftware";
const CO = "co-1";
const PROJECT_ID = "proj-guid";
const REPO_ID = "repo-guid";

const AGENTS = {
  tiamat: { id: "a-tiamat", companyId: CO, name: "Tiamat" },
  ladon: { id: "a-ladon", companyId: CO, name: "Ladon" },
  ryujin: { id: "a-ryujin", companyId: CO, name: "Ryujin" },
  /** A later hire who was given a former planner's name. */
  newTiamat: { id: "a-tiamat-2", companyId: CO, name: "Tiamat" },
  stranger: { id: "a-stranger", companyId: CO, name: "Stranger" },
  boss: { id: "a-boss", companyId: CO, name: "Boss" },
  arch: { id: "a-arch", companyId: CO, name: "Arch" },
};

const CONFIG = {
  orgUrl: ORG,
  project: "AI Testing",
  pat: { type: "secret_ref", secretId: "pat" },
  serviceBusConnection: { type: "secret_ref", secretId: "sb" },
  agentRoles: [
    { agent: "tiamat", role: "planner" },
    { agent: "Ladon", role: "reviewer" },
    { agent: "Ryujin", role: "builder" },
    { agent: "Boss", role: "director" },
    { agent: "Arch", role: "architect" },
  ],
};

/** States per type, as the Chimera process names them. */
const TYPE_STATES: Record<string, string[]> = {
  Epic: ["New", "In Progress", "Blocked", "Completed", "Removed"],
  Documentation: ["New", "In Progress", "Blocked", "Completed", "Removed"],
  Document: ["New", "In Progress", "In Review", "Changes Requested", "Blocked", "Completed", "Removed"],
  Feature: ["New", "Ready For Work", "In Progress", "Blocked", "Completed", "Removed"],
  "User Story": ["New", "In Progress", "In Review", "Changes Requested", "Blocked", "Completed", "Removed"],
  Review: ["New", "In Progress", "Changes Requested", "Blocked", "Completed", "Removed"],
  Bug: ["New", "In Progress", "In Review", "Blocked", "Completed", "Removed"],
  Task: ["New", "In Progress", "Blocked", "Completed", "Removed"],
  Defect: ["New", "In Progress", "Blocked", "Completed", "Removed"],
};

interface FakeItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  relations: Array<{ rel: string; url: string; attributes?: Record<string, unknown> }>;
}

/** A small in-memory ADO that speaks the REST calls the tools make. */
class FakeAdo {
  /** Repository files by version (branch name or commit), path to text. */
  files = new Map<string, Record<string, string>>();
  prChanges: Array<{ changeType: string; item: { path: string; isFolder?: boolean }; originalPath?: string }> = [];
  wiqlQueries: string[] = [];
  /** Fields of a type as ADO lists them; a type not here answers 404, so the tool falls back to its defaults. */
  typeFields: Record<string, Array<{ referenceName: string; name: string; alwaysRequired?: boolean; defaultValue?: unknown }>> = {};
  items = new Map<number, FakeItem>();
  comments = new Map<number, Array<{ id: number; text: string; createdBy: { displayName: string }; createdDate: string }>>();
  requests: Array<{ method: string; url: string; body?: unknown; contentType?: string }> = [];
  throttle = false;
  /** Answer every request with this status (and optional Retry-After). */
  failWith: { status: number; retryAfter?: string } | null = null;
  nextId = 500;
  /** Pull requests by id, with their threads. */
  prs = new Map<number, { id: number; title: string; status: string; source: string; target: string; description: string; workItemRefs: unknown[];
    threads: Array<{ id: number; status: string; threadContext: unknown; comments: Array<{ id: number; content: string; commentType: string; author: { displayName: string } }> }> }>();
  nextPrId = 400;
  /** The updates API: state changes per item, oldest first. */
  updates = new Map<number, Array<{ rev: number; fields: Record<string, { oldValue?: unknown; newValue: unknown }> }>>();

  /** Add a work item of `type` in `state`, optionally under `parent`. */
  add(id: number, type: string, state = "New", parent?: number) {
    this.items.set(id, {
      id,
      rev: 1,
      fields: { "System.WorkItemType": type, "System.State": state, "System.Title": `${type} ${id}`, ...(parent ? { "System.Parent": parent } : {}) },
      relations: parent ? [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${ORG}/_apis/wit/workItems/${parent}` }] : [],
    });
  }

  constructor() {
    this.items.set(42, {
      id: 42,
      rev: 7,
      fields: {
        "System.WorkItemType": "User Story",
        "System.State": "New",
        "System.Title": "Story 42",
        "System.AreaPath": "AI Testing\\Agents",
        "System.IterationPath": "AI Testing\\Sprint 1",
        "System.AssignedTo": { displayName: "AI Service" },
        "System.Description": "<div>First line<br>Second &amp; last</div>",
      },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${ORG}/_apis/wit/workItems/10` },
        { rel: "System.LinkTypes.Hierarchy-Forward", url: `${ORG}/_apis/wit/workItems/43` },
        { rel: "ArtifactLink", url: `vstfs:///Git/PullRequestId/${PROJECT_ID}%2F${REPO_ID}%2F3`, attributes: { name: "Pull Request" } },
        { rel: "Hyperlink", url: "https://example.com" },
      ],
    });
    this.comments.set(42, [
      { id: 1, text: "<p>Looks <b>good</b></p>", createdBy: { displayName: "Josh" }, createdDate: "2026-11-15T00:00:00Z" },
    ]);
  }

  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const contentType = (init?.headers as Record<string, string> | undefined)?.["Content-Type"];
    this.requests.push({ method, url, body, contentType });
    if (this.throttle) return new Response("busy", { status: 429, headers: { "Retry-After": "0" } });
    if (this.failWith) {
      const headers: Record<string, string> = this.failWith.retryAfter ? { "Retry-After": this.failWith.retryAfter } : {};
      return new Response("unavailable", { status: this.failWith.status, headers });
    }
    const path = url.slice(`${ORG}/AI%20Testing`.length).split("?")[0]!;
    let m: RegExpMatchArray | null;

    if ((m = path.match(/^\/_apis\/wit\/workItems\/(\d+)\/comments$/))) {
      const id = Number(m[1]);
      const list = this.comments.get(id) ?? [];
      if (method === "POST") {
        const c = { id: list.length + 100, text: body.text, createdBy: { displayName: "AI Service" }, createdDate: "2026-11-16T00:00:00Z" };
        list.unshift(c);
        this.comments.set(id, list);
        return Response.json(c);
      }
      return Response.json({ comments: list, totalCount: list.length });
    }
    if ((m = path.match(/^\/_apis\/wit\/workitems\/(\d+)$/))) {
      const item = this.items.get(Number(m[1]));
      if (!item) return Response.json({ message: "TF401232: Work item does not exist" }, { status: 404 });
      if (method === "PATCH") {
        for (const op of body as Array<{ op: string; path: string; value: any }>) {
          if (op.op === "test" && op.path === "/rev" && op.value !== item.rev) {
            return Response.json({ message: "TF26071: This work item has been changed by someone else" }, { status: 412 });
          }
          if (op.path === "/relations/-") item.relations.push(op.value);
          else if (op.path === "/fields/System.State") {
            const list = this.updates.get(item.id) ?? [];
            list.push({ rev: item.rev + 1, fields: { "System.State": { oldValue: item.fields["System.State"], newValue: op.value } } });
            this.updates.set(item.id, list);
            item.fields["System.State"] = op.value;
          } else if (op.path.startsWith("/fields/")) item.fields[op.path.slice(8)] = op.value;
        }
        item.rev++;
      }
      return Response.json(item);
    }
    if ((m = path.match(/^\/_apis\/wit\/workitems\/\$(.+)$/)) && method === "POST") {
      const id = this.nextId++;
      const item: FakeItem = { id, rev: 1, fields: { "System.WorkItemType": decodeURIComponent(m[1]!) }, relations: [] };
      for (const op of body) {
        if (op.path === "/relations/-") item.relations.push(op.value);
        else item.fields[op.path.slice(8)] = op.value;
      }
      this.items.set(id, item);
      return Response.json(item);
    }
    if ((m = path.match(/^\/_apis\/wit\/workitemtypes\/(.+)\/fields$/))) {
      const fields = this.typeFields[decodeURIComponent(m[1]!)];
      if (!fields) return Response.json({ message: "not in this fake" }, { status: 404 });
      return Response.json({ value: fields });
    }
    if ((m = path.match(/^\/_apis\/wit\/workitemtypes\/(.+)\/states$/))) {
      const states = TYPE_STATES[decodeURIComponent(m[1]!)] ?? ["New", "Active", "Resolved", "Closed", "Removed"];
      return Response.json({ value: states.map((name) => ({ name, category: "x" })) });
    }
    if ((m = path.match(/^\/_apis\/wit\/workItems\/(\d+)\/updates$/))) {
      const skip = Number(new URL(url).searchParams.get("$skip") ?? 0);
      return Response.json({ value: (this.updates.get(Number(m[1])) ?? []).slice(skip, skip + 200) });
    }
    // A8 read tools: files at a version, a pull request's last iteration and its changes, WIQL and batch reads.
    if ((m = path.match(/^\/_apis\/git\/repositories\/([^/]+)\/items$/))) {
      const q = new URL(url).searchParams;
      const version = q.get("versionDescriptor.version")!;
      const files = this.files.get(version) ?? {};
      const wanted = "/" + q.get("path")!.replace(/^\/+/, "").replace(/\/+$/, "");
      if (q.get("includeContent") === "true") return Response.json({ content: files[wanted], commitId: "c".repeat(40) });
      if (wanted in files) return Response.json({ value: [{ path: wanted, isFolder: false }] });
      const kids = Object.keys(files).filter((p) => p.startsWith(wanted === "/" ? "/" : `${wanted}/`));
      if (!kids.length) return Response.json({ message: "TF401174: not found" }, { status: 404 });
      return Response.json({ value: [{ path: wanted, isFolder: true }, ...kids.map((p) => ({ path: p, isFolder: false }))] });
    }
    if ((m = path.match(/^\/_apis\/git\/repositories\/[^/]+\/pullRequests\/(\d+)\/iterations$/))) {
      return Response.json({ value: [{ id: 1 }, { id: 2, sourceRefCommit: { commitId: "src" }, commonRefCommit: { commitId: "base" } }] });
    }
    if ((m = path.match(/^\/_apis\/git\/repositories\/[^/]+\/pullRequests\/(\d+)\/iterations\/2\/changes$/))) {
      return Response.json({ changeEntries: this.prChanges });
    }
    if (path === "/_apis/wit/wiql") {
      this.wiqlQueries.push(body.query);
      return Response.json({ workItems: [...this.items.keys()].filter((id) => String(this.items.get(id)!.fields["System.Title"] ?? "").toLowerCase().includes("greeting")).map((id) => ({ id })) });
    }
    if (path === "/_apis/wit/workitemsbatch") {
      return Response.json({ value: body.ids.map((id: number) => this.items.get(id) ?? null) });
    }
    if ((m = path.match(/^\/_apis\/git\/repositories\/([^/]+)$/))) {
      if (decodeURIComponent(m[1]!) !== "SimpleRepo") return Response.json({ message: "repo not found" }, { status: 404 });
      return Response.json({ id: REPO_ID, name: "SimpleRepo", project: { id: PROJECT_ID } });
    }
    const prJson = (pr: { id: number; title: string; status: string; source: string; target: string }) => ({
      pullRequestId: pr.id, title: pr.title, status: pr.status, sourceRefName: `refs/heads/${pr.source}`, targetRefName: `refs/heads/${pr.target}`,
      repository: { id: REPO_ID, name: "SimpleRepo" },
    });
    if ((m = path.match(/^\/_apis\/git\/repositories\/([^/]+)\/pullrequests$/))) {
      if (method === "POST") {
        if (body.sourceRefName === "refs/heads/missing") return Response.json({ message: "TF401398: branch not found" }, { status: 404 });
        const pr = { id: this.nextPrId++, title: body.title, status: "active", source: body.sourceRefName.slice(11), target: body.targetRefName.slice(11),
          description: body.description, workItemRefs: body.workItemRefs, threads: [] };
        this.prs.set(pr.id, pr);
        return Response.json({ pullRequestId: pr.id });
      }
      const q = new URL(url).searchParams;
      const found = [...this.prs.values()].filter((pr) => `refs/heads/${pr.source}` === q.get("searchCriteria.sourceRefName") &&
        `refs/heads/${pr.target}` === q.get("searchCriteria.targetRefName") && pr.status === q.get("searchCriteria.status"));
      return Response.json({ value: found.map((pr) => ({ pullRequestId: pr.id })) });
    }
    if ((m = path.match(/^\/_apis\/git\/(?:repositories\/[^/]+\/)?pull[rR]equests\/(\d+)\/threads(?:\/(\d+)(\/comments)?)?$/))) {
      const pr = this.prs.get(Number(m[1]));
      if (!pr) return Response.json({ message: "pr not found" }, { status: 404 });
      if (!m[2]) {
        if (method === "POST") {
          const t = { id: pr.threads.length + 1, status: body.status, threadContext: body.threadContext ?? null,
            comments: [{ id: 1, content: body.comments[0].content, commentType: "text", author: { displayName: "AI Service" } }] };
          pr.threads.push(t);
          return Response.json(t);
        }
        return Response.json({ value: pr.threads });
      }
      const t = pr.threads.find((x) => x.id === Number(m![2]));
      if (!t) return Response.json({ message: "thread not found" }, { status: 404 });
      if (m[3] && method === "POST") {
        const c = { id: t.comments.length + 1, content: body.content, commentType: "text", author: { displayName: "AI Service" } };
        t.comments.push(c);
        return Response.json(c);
      }
      if (method === "PATCH") t.status = body.status;
      return Response.json(t);
    }
    if ((m = path.match(/^\/_apis\/git\/(?:repositories\/[^/]+\/)?pullrequests\/(\d+)$/)) && this.prs.has(Number(m[1]))) {
      return Response.json(prJson(this.prs.get(Number(m[1]))!));
    }
    if ((m = path.match(/^\/_apis\/git\/repositories\/([^/]+)\/pullrequests\/(\d+)$/))) {
      if (m[2] === "404") return Response.json({ message: "pr not found" }, { status: 404 });
      return Response.json({ pullRequestId: Number(m[2]), title: "Add feature", status: "active", repository: { id: REPO_ID } });
    }
    return new Response(`unexpected ${method} ${path}`, { status: 500 });
  };

  writes() {
    return this.requests.filter((r) => r.method !== "GET");
  }
}

function link(issueId: string, workItemId: number): AdoLink {
  return { issueId, org: ORG, project: "AI Testing", workItemId, type: "User Story", state: "New", url: "u", rev: 1, syncedAt: "" };
}

interface Setup {
  tools: ReturnType<typeof registerAgentTools>;
  harness: TestHarness;
  ado: FakeAdo;
  call: (tool: string, params: unknown, agent?: keyof typeof AGENTS, runId?: string) => Promise<ToolResult>;
}

function setup(opts: { links?: Record<string, number>; config?: Record<string, unknown>; assignees?: Record<number, string> } = {}): Setup {
  const ado = new FakeAdo();
  const harness = createTestHarness({ manifest, config: opts.config ?? CONFIG });
  harness.seed({
    agents: Object.values(AGENTS) as never,
    issues: [
      { id: "issue-1", companyId: CO, assigneeAgentId: AGENTS.ryujin.id, status: "in_progress", executionRunId: "run-with-task", checkoutRunId: null, title: "t" },
      { id: "issue-2", companyId: CO, assigneeAgentId: AGENTS.ryujin.id, status: "todo", executionRunId: null, checkoutRunId: "run-unlinked", title: "t" },
    ] as never,
  });
  const linkMap = opts.links ?? { "issue-1": 42, "issue-3": 42 };
  // The agent each work item's linked task is assigned to (the item's "assignee"). Ryujin has #42.
  const assignees = opts.assignees ?? { 42: AGENTS.ryujin.id };
  const links: Pick<LinkFeatures, "findLinkByIssue" | "findTaskForWorkItem" | "onWorkItemChanged"> = {
    async findLinkByIssue(_companyId, issueId) {
      return issueId in linkMap ? link(issueId, linkMap[issueId]!) : null;
    },
    async findTaskForWorkItem(_companyId, workItemId) {
      return workItemId in assignees ? ({ id: `task-${workItemId}`, assigneeAgentId: assignees[workItemId], assigneeUserId: null } as never) : null;
    },
    async onWorkItemChanged() {},
  };
  const deps: PluginDeps = {
    ctx: harness.ctx,
    now: () => Date.now(),
    async settings() {
      return { orgUrl: ORG, project: "AI Testing" };
    },
    async adoClient() {
      return new AdoClient({ orgUrl: ORG, project: "AI Testing", pat: "pat-value", fetch: ado.fetch, sleep: async () => {} });
    },
  };
  const tools = registerAgentTools(deps, links);
  const call = (tool: string, params: unknown, agent: keyof typeof AGENTS = "tiamat", runId = "run-1") =>
    harness.executeTool<ToolResult>(tool, params, { agentId: AGENTS[agent].id, companyId: CO, runId, projectId: "" });
  return { tools, harness, ado, call };
}

function memoryStore(initial: RoleBindings = {}) {
  let bindings = { ...initial };
  return { load: async () => bindings, save: async (b: RoleBindings) => void (bindings = { ...b }), get: () => bindings };
}

describe("roles", () => {
  it("maps agent names to roles case-insensitively and defaults to readonly", async () => {
    const store = memoryStore();
    expect(await resolveRole(CONFIG.agentRoles, AGENTS.tiamat, store)).toEqual({ role: "planner" });
    expect((await resolveRole(CONFIG.agentRoles, { id: "x", name: "ladon" }, store)).role).toBe("reviewer");
    expect((await resolveRole(CONFIG.agentRoles, AGENTS.stranger, store)).role).toBe("readonly");
    expect((await resolveRole([{ agent: "Tiamat", role: "admin" }], AGENTS.tiamat, memoryStore())).role).toBe("readonly");
    expect((await resolveRole(undefined, AGENTS.tiamat, memoryStore())).role).toBe("readonly");
    expect((await resolveRole(CONFIG.agentRoles, null, memoryStore())).role).toBe("readonly");
  });

  it("binds a name to the first agent that uses it; another agent with that name is readonly", async () => {
    const store = memoryStore();
    await resolveRole(CONFIG.agentRoles, AGENTS.tiamat, store);
    expect(store.get()).toEqual({ tiamat: AGENTS.tiamat.id });
    const other = await resolveRole(CONFIG.agentRoles, AGENTS.newTiamat, store);
    expect(other.role).toBe("readonly");
    expect(other.downgraded).toContain("first used by a different agent (a-tiamat)");
    expect((await resolveRole(CONFIG.agentRoles, AGENTS.tiamat, store)).role).toBe("planner");
  });

  it("an agentId on the entry always wins over the name", async () => {
    const roles = [{ agent: "Tiamat", role: "planner", agentId: AGENTS.newTiamat.id }];
    const store = memoryStore({ tiamat: AGENTS.tiamat.id });
    expect((await resolveRole(roles, AGENTS.newTiamat, store)).role).toBe("planner");
    const old = await resolveRole(roles, AGENTS.tiamat, store);
    expect(old).toMatchObject({ role: "readonly", downgraded: expect.stringContaining("pinned to a different agent id") });
    expect((await resolveRole([{ agent: "Old name", role: "builder", agentId: AGENTS.ryujin.id }], AGENTS.ryujin, memoryStore())).role).toBe("builder");
  });

  it("drops bindings for names no longer listed, so remove and re-add resets them", () => {
    expect(pruneBindings([{ agent: "Ladon", role: "reviewer" }], { tiamat: "a", ladon: "b" })).toEqual({ ladon: "b" });
  });

  it("readonly only reads; the create tool goes to the roles the creation table names", () => {
    expect(ROLE_POLICIES.readonly.tools).toEqual([
      TOOL_NAMES.getWorkItem,
      TOOL_NAMES.getWorkflow,
      TOOL_NAMES.getPullRequestThreads,
      TOOL_NAMES.getPullRequestChanges,
      TOOL_NAMES.getFile,
      TOOL_NAMES.searchWorkItems,
    ]);
    for (const role of ["director", "planner", "architect", "builder", "reviewer", "qa"] as const) {
      expect(ROLE_POLICIES[role].tools).toContain(TOOL_NAMES.postPullRequestComment);
    }
    for (const role of ["reviewer", "qa", "readonly"] as const) expect(ROLE_POLICIES[role].tools).not.toContain(TOOL_NAMES.createPullRequest);
    expect(ROLE_POLICIES.builder.tools).toContain(TOOL_NAMES.createPullRequest);
    for (const role of ["director", "planner", "builder"] as const) expect(ROLE_POLICIES[role].tools).toContain(TOOL_NAMES.createWorkItem);
    for (const role of ["architect", "reviewer", "readonly"] as const) expect(ROLE_POLICIES[role].tools).not.toContain(TOOL_NAMES.createWorkItem);
    for (const role of ["director", "planner", "architect", "builder", "reviewer"] as const) expect(ROLE_POLICIES[role].tools).toContain(TOOL_NAMES.assign);
    expect(ROLE_POLICIES.reviewer.tools).not.toContain(TOOL_NAMES.linkPullRequest);
    expect(ROLE_POLICIES.architect.tools).toEqual([...ROLE_POLICIES.builder.tools.filter((t) => t !== TOOL_NAMES.createWorkItem), TOOL_NAMES.setTechnicalNotes]);
    // Authors write Documents as pull requests: no work items, no technical notes.
    expect(ROLE_POLICIES.author.tools).toContain(TOOL_NAMES.createPullRequest);
    for (const t of [TOOL_NAMES.createWorkItem, TOOL_NAMES.setTechnicalNotes]) expect(ROLE_POLICIES.author.tools).not.toContain(t);
    for (const role of ["director", "planner", "architect"] as const) expect(ROLE_POLICIES[role].tools).toContain(TOOL_NAMES.setTechnicalNotes);
    for (const role of ["builder", "reviewer", "qa", "readonly"] as const) expect(ROLE_POLICIES[role].tools).not.toContain(TOOL_NAMES.setTechnicalNotes);
  });

  it("maps the director and architect roles", async () => {
    expect((await resolveRole(CONFIG.agentRoles, AGENTS.boss, memoryStore())).role).toBe("director");
    expect((await resolveRole(CONFIG.agentRoles, AGENTS.arch, memoryStore())).role).toBe("architect");
  });
});

/**
 * Copy of inferToolRisk in server/src/services/tool-gateway.ts. The host rates
 * a tool by its name, and a "read" tool can run without approval, so every
 * tool that writes must be rated "write". Keep in step with the host function.
 */
function hostToolRisk(toolName: string): "destructive" | "write" | "read" {
  const lower = toolName.toLowerCase();
  if (/\b(delete|destroy|remove|drop|truncate|wipe|purge)\b|(^|[:._-])(delete|destroy|remove|drop|truncate|wipe|purge)([:._-]|$)/.test(lower)) {
    return "destructive";
  }
  if (/\b(create|update|write|edit|patch|post|send|publish|merge|commit|apply)\b|(^|[:._-])(create|update|write|edit|patch|post|send|publish|merge|commit|apply)([:._-]|$)/.test(lower)) {
    return "write";
  }
  return "read";
}

describe("host risk rating of tool names", () => {
  it("rates every writing tool as write and the read tool as read", () => {
    for (const t of TOOL_DECLARATIONS) {
      const namespaced = `chimera.plugin-ado:${t.name}`;
      const reads: string[] = [
        TOOL_NAMES.getWorkItem,
        TOOL_NAMES.getWorkflow,
        TOOL_NAMES.getPullRequestThreads,
        TOOL_NAMES.getPullRequestChanges,
        TOOL_NAMES.getFile,
        TOOL_NAMES.searchWorkItems,
      ];
      expect([t.name, hostToolRisk(t.name)]).toEqual([t.name, reads.includes(t.name) ? "read" : "write"]);
      expect(hostToolRisk(namespaced)).toBe(hostToolRisk(t.name));
    }
  });
});

describe("pull request tools", () => {
  it("opens a signed pull request linked to the task's work item, and returns the open one instead of a second", async () => {
    const s = setup();
    const params = { repository: "SimpleRepo", sourceBranch: "refs/heads/ai/42-story", title: "#42 Story", description: "Adds the line." };
    const res = await s.call(TOOL_NAMES.createPullRequest, params, "ryujin", "run-with-task");
    expect(res.error).toBeUndefined();
    expect(res.content).toBe(
      `Opened pull request 400 "#42 Story" from ai/42-story into main in SimpleRepo, linked to #42: ${ORG}/AI%20Testing/_git/SimpleRepo/pullrequest/400`,
    );
    expect(s.ado.prs.get(400)).toMatchObject({ source: "ai/42-story", target: "main", description: "Adds the line.\n\n_Opened by [Ryujin]._", workItemRefs: [{ id: "42" }] });
    expect(s.harness.activity.at(-1)).toMatchObject({ message: "[Ryujin] opened PR 400 in SimpleRepo (ai/42-story into main)" });

    const again = await s.call(TOOL_NAMES.createPullRequest, params, "ryujin", "run-with-task");
    expect(again.content).toMatch(/^An active pull request from ai\/42-story into main already exists: 400 "#42 Story"/);
    expect(s.ado.prs.size).toBe(1);
  });

  it("links the work items given, refuses a missing branch, and is not for reviewers", async () => {
    const s = setup();
    const res = await s.call(TOOL_NAMES.createPullRequest, { repository: "SimpleRepo", sourceBranch: "ai/55-fix", title: "#55 Fix", workItemIds: [55, 42, 55] }, "ryujin");
    expect(res.data).toMatchObject({ pullRequestId: 400, workItemIds: [55, 42] });
    expect((await s.call(TOOL_NAMES.createPullRequest, { repository: "SimpleRepo", sourceBranch: "missing", title: "x", workItemIds: [42] }, "ryujin")).error).toMatch(
      /branch missing or main was not found in SimpleRepo\. Push the branch first\./,
    );
    expect((await s.call(TOOL_NAMES.createPullRequest, { repository: "SimpleRepo", sourceBranch: "main", title: "x", workItemIds: [42] }, "ryujin")).error).toMatch(
      /same branch/,
    );
    expect((await s.call(TOOL_NAMES.createPullRequest, { repository: "SimpleRepo", sourceBranch: "a", title: "x", workItemIds: [42] }, "ladon")).error).toMatch(
      /^Permission denied: Ladon has the ADO role "reviewer"/,
    );
  });

  it("starts signed threads (on a file and line), replies, sets thread status, and reads them back", async () => {
    const s = setup();
    await s.call(TOOL_NAMES.createPullRequest, { repository: "SimpleRepo", sourceBranch: "ai/42-story", title: "#42 Story", workItemIds: [42] }, "ryujin");
    const finding = await s.call(TOOL_NAMES.postPullRequestComment, { pullRequestId: 400, text: "Say Hello from the agents.", filePath: "HelloWorld.md", line: 1 }, "ladon");
    expect(finding.error).toBeUndefined();
    expect(finding.data).toMatchObject({ threadId: 1, status: "active" });
    expect(s.ado.prs.get(400)!.threads[0]).toMatchObject({
      status: "active",
      threadContext: { filePath: "/HelloWorld.md", rightFileStart: { line: 1, offset: 1 } },
      comments: [{ content: "[Ladon] Say Hello from the agents." }],
    });
    const reply = await s.call(TOOL_NAMES.postPullRequestComment, { repository: "SimpleRepo", pullRequestId: 400, threadId: 1, text: "[Ryujin] Fixed in abc123.", status: "Fixed" }, "ryujin");
    expect(reply.content).toBe("Replied on thread 1 of pull request 400 and set it fixed.");
    expect(s.ado.prs.get(400)!.threads[0]).toMatchObject({ status: "fixed", comments: [{}, { content: "[Ryujin] Fixed in abc123." }] });

    const read = await s.call(TOOL_NAMES.getPullRequestThreads, { pullRequestId: 400 }, "stranger");
    expect(read.error).toBeUndefined();
    expect(read.content).toContain("Thread 1 (fixed) on /HelloWorld.md line 1:\n- AI Service: [Ladon] Say Hello from the agents.\n- AI Service: [Ryujin] Fixed in abc123.");
    expect((await s.call(TOOL_NAMES.postPullRequestComment, { pullRequestId: 400, text: "x", threadId: 9 }, "ladon")).error).toMatch(/^Thread 9 was not found/);
    expect((await s.call(TOOL_NAMES.postPullRequestComment, { pullRequestId: 400, text: "x", status: "done" }, "ladon")).error).toMatch(/^status must be one of/);
    expect((await s.call(TOOL_NAMES.postPullRequestComment, { pullRequestId: 400, text: "x" }, "stranger")).error).toMatch(/^Permission denied/);
    s.ado.prs.get(400)!.status = "completed";
    expect((await s.call(TOOL_NAMES.postPullRequestComment, { pullRequestId: 400, text: "late" }, "ladon")).error).toBe(
      "Pull request 400 is completed, so nothing was posted. Comment on the work item instead.",
    );
  });
});

describe("technical notes", () => {
  it("writes the field on a planning type, signed in the history, and refuses other types and other roles", async () => {
    const s = setup();
    const res = await s.call(TOOL_NAMES.setTechnicalNotes, { workItemId: 42, notes: "Use the cache.\nNo new tables." }, "arch");
    expect(res.error).toBeUndefined();
    expect(s.ado.items.get(42)!.fields["Custom.TechnicalNotes"]).toBe("Use the cache.<br>No new tables.");
    expect(s.ado.items.get(42)!.fields["System.History"]).toBe("[Arch] Updated the technical notes.");
    s.ado.add(70, "Review", "New", 42);
    expect((await s.call(TOOL_NAMES.setTechnicalNotes, { workItemId: 70, notes: "x" }, "arch")).error).toBe(
      "Nothing was changed: a Review has no technical notes; they go on an Epic, Feature, User Story, Bug or Task.",
    );
    expect((await s.call(TOOL_NAMES.setTechnicalNotes, { workItemId: 42, notes: "x" }, "ryujin")).error).toMatch(/^Permission denied: Ryujin has the ADO role "builder"/);
  });
});

describe("html", () => {
  it("escapes agent text, keeps line breaks and prefixes the agent name", () => {
    expect(textToHtml('<script>alert("x")</script>\r\nnext & last')).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>next &amp; last");
    expect(attributedHtml("Ty<r>", "hi\nthere")).toBe("[Ty&lt;r&gt;] hi<br>there");
  });

  it("flattens ADO HTML to text", () => {
    expect(htmlToText("<div>a<br/>b &amp; c</div><ul><li>one</li><li>two</li></ul>&#39;q&#x27;")).toBe("a\nb & c\n- one\n- two\n'q'");
  });
});

describe("manifest", () => {
  it("declares every tool and the capabilities A8 needs", () => {
    expect((manifest.tools ?? []).map((t) => t.name)).toEqual(Object.values(TOOL_NAMES));
    for (const cap of ["agent.tools.register", "agents.read", "issues.read", "activity.log.write"]) {
      expect(manifest.capabilities).toContain(cap);
    }
    const roles = (manifest.instanceConfigSchema as any).properties.agentRoles;
    expect(roles.items.properties.role.enum).toEqual(["director", "planner", "architect", "author", "builder", "reviewer", "qa", "readonly"]);
    expect(manifest.capabilities).toContain("issue.comments.create");
  });

  it("gives every tool an object schema that rejects unknown parameters", () => {
    for (const t of TOOL_DECLARATIONS) {
      expect(t.parametersSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(t.description.length).toBeGreaterThan(40);
    }
  });
});

describe("ADO client additions", () => {
  it("uses the right URLs, API versions and content types", async () => {
    const ado = new FakeAdo();
    const client = new AdoClient({ orgUrl: ORG, project: "AI Testing", pat: "p", fetch: ado.fetch });
    await client.listComments(42, 3);
    await client.addComment(42, "x");
    await client.updateWorkItem(42, [{ op: "test", path: "/rev", value: 7 }]);
    await client.createWorkItem("User Story", [{ op: "add", path: "/fields/System.Title", value: "t" }]);
    expect(await client.getWorkItemTypeStates("User Story")).toContainEqual({ name: "In Progress", category: "x" });
    expect(await client.getRepository("SimpleRepo")).toEqual({ id: REPO_ID, name: "SimpleRepo", projectId: PROJECT_ID });
    expect((await client.getPullRequest(REPO_ID, 5)).title).toBe("Add feature");
    const [list, add, patch, create, states] = ado.requests;
    expect(list!.url).toBe(`${ORG}/AI%20Testing/_apis/wit/workItems/42/comments?$top=3&order=desc&$expand=renderedText&api-version=7.1-preview.4`);
    expect(add).toMatchObject({ method: "POST", body: { text: "x" } });
    expect(patch).toMatchObject({ method: "PATCH", contentType: "application/json-patch+json" });
    expect(create!.url).toBe(`${ORG}/AI%20Testing/_apis/wit/workitems/$User%20Story?api-version=7.1`);
    expect(create!.contentType).toBe("application/json-patch+json");
    expect(states!.url).toContain("/_apis/wit/workitemtypes/User%20Story/states?api-version=7.1");
    expect(client.workItemApiUrl(10)).toBe(`${ORG}/_apis/wit/workItems/10`);
  });

  it("never retries a comment or create on 503, nor on 429 without Retry-After; retries reads", async () => {
    const ado = new FakeAdo();
    const client = new AdoClient({ orgUrl: ORG, project: "AI Testing", pat: "p", fetch: ado.fetch, sleep: async () => {} });
    ado.failWith = { status: 503, retryAfter: "1" };
    expect((await client.addComment(42, "x").catch((e) => e)).status).toBe(503);
    expect((await client.createWorkItem("Task", []).catch((e) => e)).status).toBe(503);
    expect(ado.requests).toHaveLength(2);
    ado.failWith = { status: 429 };
    await client.addComment(42, "x").catch(() => {});
    expect(ado.requests).toHaveLength(3);
    ado.failWith = { status: 429, retryAfter: "1" };
    await client.addComment(42, "x").catch(() => {});
    expect(ado.requests).toHaveLength(5);
    ado.failWith = { status: 503 };
    await client.getWorkItem(42).catch(() => {});
    expect(ado.requests).toHaveLength(7);
  });

  it("keeps ADO's own error message apart from the request", async () => {
    const ado = new FakeAdo();
    const client = new AdoClient({ orgUrl: ORG, project: "AI Testing", pat: "secret-pat", fetch: ado.fetch });
    const err = await client.getWorkItem(999).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.detail).toBe("TF401232: Work item does not exist");
    expect(err.message).not.toContain("secret-pat");
  });
});

describe("agent tools", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("permissions", () => {
    it("lets an unlisted agent read but not write, with a clear message", async () => {
      const s = setup();
      const read = await s.call(TOOL_NAMES.getWorkItem, { workItemId: 42 }, "stranger");
      expect(read.error).toBeUndefined();
      const denied = await s.call(TOOL_NAMES.addComment, { workItemId: 42, text: "hi" }, "stranger");
      expect(denied.error).toMatch(/^Permission denied: Stranger has the ADO role "readonly", which allows only ado_get_work_item, ado_get_workflow, ado_get_pr_threads, ado_get_pr_changes, ado_get_file, ado_search_work_items\./);
      expect(s.ado.writes()).toHaveLength(0);
      expect(s.harness.activity).toHaveLength(0);
    });

    it("reviewers may comment and set state but not link PRs or create items", async () => {
      const s = setup();
      expect((await s.call(TOOL_NAMES.addComment, { workItemId: 42, text: "ok" }, "ladon")).error).toBeUndefined();
      expect((await s.call(TOOL_NAMES.linkPullRequest, { workItemId: 42, repository: "SimpleRepo", pullRequestId: 5 }, "ladon")).error).toMatch(/Permission denied/);
      expect((await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Task", title: "x" }, "ladon")).error).toMatch(/Permission denied/);
    });

    it("builders may create Tasks only, under the right parent type; planners any type", async () => {
      const s = setup();
      const feature = await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Feature", title: "x" }, "ryujin");
      expect(feature.error).toBe(
        'Workflow rule "create Feature": only the planner role may create Feature work items. Your role (builder) may create: Task. Read the rules with ado_get_workflow.',
      );
      expect((await s.call(TOOL_NAMES.createWorkItem, { type: "Bug", title: "x" }, "ryujin")).error).toMatch(/only the planner role may create Bug work items \(Josh enters Bugs in ADO\)/);
      expect((await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Feature", title: "x" }, "tiamat")).error).toBe(
        'Workflow rule "create Feature": a Feature goes under an Epic, not under a User Story. Read the rules with ado_get_workflow.',
      );
      expect(s.ado.writes()).toHaveLength(0);
      expect((await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "task", title: "x" }, "ryujin")).error).toBeUndefined();
      expect(s.ado.writes()[0]!.url).toContain("/$Task?");
      expect((await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Test Case", title: "x" }, "tiamat")).error).toBeUndefined();
    });
  });

  it("ado_get_work_item returns fields, a relations summary and recent comments as text", async () => {
    const s = setup();
    const res = await s.call(TOOL_NAMES.getWorkItem, { workItemId: 42, commentCount: 3 });
    const data = res.data as any;
    expect(data).toMatchObject({
      id: 42,
      rev: 7,
      type: "User Story",
      state: "New",
      assignedTo: "AI Service",
      description: "First line\nSecond & last",
      parent: 10,
      children: [43],
      pullRequests: [{ repositoryId: REPO_ID, pullRequestId: 3 }],
      otherLinks: 1,
      url: `${ORG}/AI%20Testing/_workitems/edit/42`,
    });
    expect(data.comments).toEqual([{ id: 1, author: "Josh", date: "2026-11-15T00:00:00Z", text: "Looks good" }]);
    expect(JSON.parse(res.content!)).toEqual(data);
  });

  it("ado_post_comment escapes the text, prefixes the agent and records the write", async () => {
    const s = setup();
    const res = await s.call(TOOL_NAMES.addComment, { workItemId: 42, text: "Done <b>now</b>\nsee PR" }, "ryujin", "run-with-task");
    expect(res.error).toBeUndefined();
    expect(s.ado.writes()[0]!.body).toEqual({ text: "[Ryujin] Done &lt;b&gt;now&lt;/b&gt;<br>see PR" });
    expect(s.harness.activity).toEqual([
      expect.objectContaining({
        companyId: CO,
        message: "[Ryujin] commented on ADO #42",
        entityType: "issue",
        entityId: "issue-1",
        metadata: expect.objectContaining({ action: "comment_added", agentId: AGENTS.ryujin.id, agentName: "Ryujin", runId: "run-with-task", workItemId: 42 }),
      }),
    ]);
  });

  describe("A7 agent tag", () => {
    it("replaces any earlier agent tag and keeps other tags", async () => {
      const { agentTag, hasOnlyAgentTag, withAgentTag } = await import("../src/tools/tags.js");
      expect(withAgentTag("frontend; agent:Ladon; urgent", "Ryujin")).toBe("frontend; urgent; agent:Ryujin");
      expect(withAgentTag(undefined, "Ryujin")).toBe("agent:Ryujin");
      expect(agentTag("Bad;Name,x")).toBe("agent:Bad Name x");
      expect(hasOnlyAgentTag("frontend; agent:ryujin", "Ryujin")).toBe(true);
      expect(hasOnlyAgentTag("agent:Ladon; agent:Ryujin", "Ryujin")).toBe(false);
    });

    it("tags the item after a comment, once", async () => {
      const s = setup();
      await s.call(TOOL_NAMES.addComment, { workItemId: 42, text: "one" }, "ryujin");
      const tagPatch = s.ado.writes()[1]!;
      expect(tagPatch.body).toEqual([
        { op: "test", path: "/rev", value: 7 },
        { op: "add", path: "/fields/System.Tags", value: "agent:Ryujin" },
      ]);
      await s.call(TOOL_NAMES.addComment, { workItemId: 42, text: "two" }, "ryujin");
      // Second comment by the same agent: the tag is already right, so no extra update.
      expect(s.ado.writes()).toHaveLength(3);
    });
  });

  describe("ado_update_state", () => {
    it("lists the valid states when the target is not one of them", async () => {
      const s = setup();
      const res = await s.call(TOOL_NAMES.setState, { workItemId: 42, state: "Doing" });
      expect(res.error).toBe('"Doing" is not a state of User Story. Valid states: New, In Progress, In Review, Changes Requested, Blocked, Completed, Removed.');
      expect(s.ado.writes()).toHaveLength(0);
    });

    it("patches with test /rev first, attributes the history and caches the type's states", async () => {
      const s = setup();
      const res = await s.call(TOOL_NAMES.setState, { workItemId: 42, state: "in progress", comment: "Starting work" }, "ryujin");
      expect(res.content).toBe("Work item #42 moved from New to In Progress.");
      const patch = s.ado.writes()[0]!;
      expect(patch.body).toEqual([
        { op: "test", path: "/rev", value: 7 },
        { op: "replace", path: "/fields/System.State", value: "In Progress" },
        { op: "add", path: "/fields/System.History", value: "[Ryujin] Changed state from New to In Progress.<br>Starting work" },
        { op: "add", path: "/fields/System.Tags", value: "agent:Ryujin" },
      ]);
      expect(s.harness.activity[0]).toMatchObject({
        message: "[Ryujin] moved ADO #42 from New to In Progress",
        metadata: { from: "New", to: "In Progress", rule: "User Story, Bug: In Progress, In Review, Ready To Merge, In Testing, Completed, Blocked" },
      });

      await s.call(TOOL_NAMES.setState, { workItemId: 42, state: "In Review" }, "ryujin");
      expect(s.ado.requests.filter((r) => r.url.includes("/states")).length).toBe(1);
      expect((await s.call(TOOL_NAMES.setState, { workItemId: 42, state: "In Review" }, "ryujin")).content).toMatch(/already In Review/);
    });

    it("counts review rounds since the Review last approved", () => {
      const st = (from: string, to: string) => ({ rev: 1, revisedBy: "x", revisedDate: null, fields: { "System.State": { oldValue: from, newValue: to } } });
      expect(countReviewRounds([st("In Review", "Changes Requested"), st("Ready For Review", "Approved"), st("In Review", "Changes Requested")])).toBe(1);
      expect(countReviewRounds([st("In Review", "Changes Requested"), st("Ready For Review", "Changes Requested")])).toBe(2);
      expect(countReviewRounds([])).toBe(0);
    });

    it("tells the agent to re-read when the item changed underneath it", async () => {
      const s = setup();
      const realFetch = s.ado.fetch;
      // Someone edits the item between our read and our write.
      s.ado.fetch = async (input, init) => {
        if (init?.method === "PATCH") s.ado.items.get(42)!.rev = 99;
        return realFetch(input, init);
      };
      const res = await s.call(TOOL_NAMES.setState, { workItemId: 42, state: "In Progress" }, "ryujin");
      expect(res.error).toMatch(/changed since it was read.*Re-read it with ado_get_work_item/);
      expect(s.harness.activity).toHaveLength(0);
    });
  });

  it("returns a throttling message after the client's one retry", async () => {
    const s = setup();
    s.ado.throttle = true;
    const res = await s.call(TOOL_NAMES.getWorkItem, { workItemId: 42 });
    expect(res.error).toMatch(/^ADO is throttling requests from the shared service account\. Try again later/);
    expect(s.ado.requests).toHaveLength(2);
  });

  it("reports a 503 as unavailable, not throttling, and does not repeat the comment", async () => {
    const s = setup();
    s.ado.failWith = { status: 503 };
    const res = await s.call(TOOL_NAMES.addComment, { workItemId: 42, text: "hi" });
    expect(res.error).toMatch(/^ADO is unavailable right now/);
    expect(s.ado.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("treats a newly hired agent with a bound name as readonly and says why", async () => {
    const s = setup();
    expect((await s.call(TOOL_NAMES.addComment, { workItemId: 42, text: "first" }, "tiamat")).error).toBeUndefined();
    const res = await s.call(TOOL_NAMES.addComment, { workItemId: 42, text: "me too" }, "newTiamat");
    expect(res.error).toMatch(/^Permission denied: Tiamat has the ADO role "readonly".*You are treated as readonly because the "Tiamat" entry was first used by a different agent/);
    expect(s.harness.logs.some((l) => l.level === "warn" && l.message.includes("treated as readonly"))).toBe(true);

    // Removing the entry and saving resets the binding; re-adding it binds the next agent to use it.
    await s.tools.onConfigChanged(CO, { ...CONFIG, agentRoles: CONFIG.agentRoles.filter((e) => e.role !== "planner") });
    expect(s.harness.getState({ scopeKind: "company", scopeId: CO, stateKey: "agent-role-bindings" })).toEqual({});
    expect((await s.call(TOOL_NAMES.addComment, { workItemId: 42, text: "now me" }, "newTiamat")).error).toBeUndefined();
  });

  describe("ado_create_pr_link", () => {
    it("adds the PR artifact link by repository name, once", async () => {
      const s = setup();
      const res = await s.call(TOOL_NAMES.linkPullRequest, { workItemId: 42, repository: "SimpleRepo", pullRequestId: 5 }, "ryujin");
      expect(res.content).toBe("Pull request 5 (Add feature) in SimpleRepo linked to work item #42.");
      expect(s.ado.writes()[0]!.body).toEqual([
        { op: "test", path: "/rev", value: 7 },
        {
          op: "add",
          path: "/relations/-",
          value: { rel: "ArtifactLink", url: `vstfs:///Git/PullRequestId/${PROJECT_ID}%2F${REPO_ID}%2F5`, attributes: { name: "Pull Request" } },
        },
        { op: "add", path: "/fields/System.History", value: "[Ryujin] Linked pull request 5 (Add feature) in SimpleRepo." },
        { op: "add", path: "/fields/System.Tags", value: "agent:Ryujin" },
      ]);
      const again = await s.call(TOOL_NAMES.linkPullRequest, { workItemId: 42, repository: "SimpleRepo", pullRequestId: 5 }, "ryujin");
      expect(again.content).toMatch(/already linked/);
      expect(s.ado.writes()).toHaveLength(1);
    });

    it("says which of repository or PR was not found", async () => {
      const s = setup();
      expect((await s.call(TOOL_NAMES.linkPullRequest, { workItemId: 42, repository: "Nope", pullRequestId: 5 })).error).toBe(
        'Repository "Nope" was not found in the ADO project.',
      );
      expect((await s.call(TOOL_NAMES.linkPullRequest, { workItemId: 42, repository: "SimpleRepo", pullRequestId: 404 })).error).toBe(
        "Pull request 404 was not found in repository SimpleRepo.",
      );
    });
  });

  it("ado_create_work_item links the parent and inherits its area and iteration", async () => {
    const s = setup();
    const res = await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Task", title: "Write tests", description: "a < b\nc" }, "ryujin");
    expect(res.data).toMatchObject({ workItemId: 500, parentId: 42, type: "Task" });
    const create = s.ado.writes()[0]!;
    expect(create.url).toContain("/_apis/wit/workitems/$Task?");
    expect(create.body).toEqual([
      { op: "add", path: "/fields/System.Title", value: "Write tests" },
      { op: "add", path: "/fields/System.Description", value: "a &lt; b<br>c" },
      { op: "add", path: "/fields/System.AreaPath", value: "AI Testing\\Agents" },
      { op: "add", path: "/fields/System.IterationPath", value: "AI Testing\\Sprint 1" },
      { op: "add", path: "/fields/System.History", value: "[Ryujin] Created as a child of #42." },
      { op: "add", path: "/fields/System.Tags", value: "agent:Ryujin" },
      { op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${ORG}/_apis/wit/workItems/42` } },
    ]);
    expect(s.harness.activity[0]).toMatchObject({ message: "[Ryujin] created Task ADO #500 under #42", metadata: { workItemId: 500, parentId: 42 } });
  });

  it("ado_create_work_item copies Josh's instructions from the items above, once", async () => {
    const s = setup();
    s.ado.add(30, "Epic", "In Progress");
    s.ado.items.get(30)!.fields["System.Description"] =
      "Build a file.<br><br>Instructions from Josh:<br>- Review: ask for one change.<br>- QA Test: fail once with a Defect.";
    s.ado.add(31, "Feature", "Refining", 30);
    s.ado.add(32, "User Story", "New", 31);
    const descriptionOf = (i: number) => (s.ado.writes()[i]!.body as Array<{ path: string; value: unknown }>).find((o) => o.path === "/fields/System.Description")?.value;

    // The Feature had no copy (as in smoke test #848): the Review still gets the Epic's instructions.
    const review = await s.call(TOOL_NAMES.createWorkItem, { parentId: 32, type: "Review", title: "Code review", description: "Review the pull request." }, "tiamat");
    expect(review.error).toBeUndefined();
    expect(review.data).toMatchObject({ instructionsCopiedFrom: [30] });
    expect(review.content).toContain("Copied Josh's instructions from #30");
    expect(descriptionOf(0)).toBe(
      "Review the pull request.<br><br>Instructions from Josh (copied from #30):<br>- Review: ask for one change.<br>- QA Test: fail once with a Defect.",
    );

    // An agent's own copy is kept and not repeated; a copy further up counts as the same text.
    s.ado.items.get(31)!.fields["System.Description"] = "Outcome.<br><br>Instructions from Josh (copied from #30):<br>- Review: ask for one change.<br>- QA Test: fail once with a Defect.";
    const qa = await s.call(
      TOOL_NAMES.createWorkItem,
      { parentId: 32, type: "QA Test", title: "Test", description: "Steps.\n\nInstructions from Josh:\n- Review: ask for one change.\n- QA Test: fail once with a Defect." },
      "tiamat",
    );
    expect(qa.data).not.toHaveProperty("instructionsCopiedFrom");
    expect(descriptionOf(1)).toBe("Steps.<br><br>Instructions from Josh:<br>- Review: ask for one change.<br>- QA Test: fail once with a Defect.");
  });

  it("ado_create_work_item fills Repro Steps on a Defect (ADO requires it), from reproSteps or the description", async () => {
    const s = setup();
    const opsOf = (i: number) => s.ado.writes()[i]!.body as Array<{ path: string; value: unknown }>;
    const repro = (i: number) => opsOf(i).find((o) => o.path === "/fields/Microsoft.VSTS.TCM.ReproSteps")?.value;

    const given = await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Defect", title: "Date prefix", description: "Line 2 lacks Date:", reproSteps: "1. cat file\nExpected: Date: x\nActual: x" });
    expect(given.error).toBeUndefined();
    expect(repro(0)).toBe("1. cat file<br>Expected: Date: x<br>Actual: x");

    const fromDescription = await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Defect", title: "Date prefix", description: "Steps: cat file" });
    expect(fromDescription.error).toBeUndefined();
    expect(repro(1)).toBe("Steps: cat file");

    expect((await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Defect", title: "No steps" })).error).toMatch(/a Defect requires `reproSteps`/);
    expect((await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Task", title: "t", reproSteps: "x" })).error).toMatch(/a Task has no repro steps field/);
    expect(s.ado.writes()).toHaveLength(2);
  });

  it("ado_create_work_item checks the fields ADO requires on the type before creating (a Defect needing acceptance criteria)", async () => {
    const s = setup();
    s.ado.typeFields.Defect = [
      { referenceName: "System.Title", name: "Title", alwaysRequired: true },
      { referenceName: "System.Description", name: "Description" },
      { referenceName: "Microsoft.VSTS.TCM.ReproSteps", name: "Repro Steps", alwaysRequired: true },
      { referenceName: "Microsoft.VSTS.Common.AcceptanceCriteria", name: "Acceptance Criteria", alwaysRequired: true },
      { referenceName: "Microsoft.VSTS.Common.Priority", name: "Priority", alwaysRequired: true, defaultValue: 2 },
    ];
    const ac = (i: number) => (s.ado.writes()[i]!.body as Array<{ path: string; value: unknown }>).find((o) => o.path === "/fields/Microsoft.VSTS.Common.AcceptanceCriteria")?.value;

    const missing = await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Defect", title: "Date prefix", description: "Line 2 lacks Date:" });
    expect(missing.error).toMatch(/a Defect requires `acceptanceCriteria`/);
    expect(s.ado.writes()).toHaveLength(0);

    const ok = await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Defect", title: "Date prefix", description: "Line 2 lacks Date:", acceptanceCriteria: "Line 2 starts with Date: " });
    expect(ok.error).toBeUndefined();
    expect(ac(0)).toBe("Line 2 starts with Date: ");

    // A required custom field with no default is named before anything is sent.
    s.ado.typeFields.Defect.push({ referenceName: "Custom.Severity", name: "Severity", alwaysRequired: true });
    const custom = await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Defect", title: "x", description: "y", acceptanceCriteria: "z" });
    expect(custom.error).toMatch(/"Severity" \(Custom.Severity\), which this tool cannot fill/);
    expect(s.ado.writes()).toHaveLength(1);
  });

  it("repository (A12): technical notes and new items carry a repo tag, and children take their parent's", async () => {
    const s = setup();
    const tagsOf = (i: number) => (s.ado.writes()[i]!.body as Array<{ path: string; value: unknown }>).find((o) => o.path === "/fields/System.Tags")?.value;

    const notes = await s.call(TOOL_NAMES.setTechnicalNotes, { workItemId: 42, notes: "Use the cache.", repository: "SimpleRepo" }, "arch");
    expect(notes.error).toBeUndefined();
    expect(notes.content).toContain("Repository set to SimpleRepo");
    expect(String(tagsOf(0))).toMatch(/repo:SimpleRepo/);
    expect((await s.call(TOOL_NAMES.setTechnicalNotes, { workItemId: 42, notes: "x", repository: "Nope" }, "arch")).error).toMatch(/no repository "Nope"/);

    // #42 now carries the tag: a Review created under it gets it too.
    s.ado.items.get(42)!.fields["System.Tags"] = "agent:Arch; repo:SimpleRepo";
    const review = await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Review", title: "Code review" }, "tiamat");
    expect(review.data).toMatchObject({ repository: "SimpleRepo" });
    expect(tagsOf(1)).toBe("agent:Tiamat; repo:SimpleRepo");

    // Given on creation, it is checked against ADO and written with ADO's spelling.
    s.ado.items.get(42)!.fields["System.Tags"] = "";
    const task = await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Task", title: "t", repository: "SimpleRepo" }, "tiamat");
    expect(tagsOf(2)).toBe("agent:Tiamat; repo:SimpleRepo");
    expect(task.data).toMatchObject({ repository: "SimpleRepo" });
  });

  it("ado_get_file reads a file with line numbers, in windows, and lists a folder (A8)", async () => {
    const s = setup();
    s.ado.files.set("main", { "/docs/prd.md": "# PRD\nLine two\n", "/docs/adr/0001.md": "x" });
    s.ado.files.set("ai/9-x", { "/docs/prd.md": "changed" });
    const file = await s.call(TOOL_NAMES.getFile, { repository: "SimpleRepo", path: "docs/prd.md" }, "ladon");
    expect(file.error).toBeUndefined();
    expect(file.content).toBe("SimpleRepo docs/prd.md at branch main (commit cccccccc), lines 1-2 of 2:\n    1  # PRD\n    2  Line two");
    expect((await s.call(TOOL_NAMES.getFile, { repository: "SimpleRepo", path: "/docs/prd.md", branch: "refs/heads/ai/9-x" }, "ladon")).content).toContain("1  changed");
    const folder = await s.call(TOOL_NAMES.getFile, { repository: "SimpleRepo", path: "docs" }, "ladon");
    expect(folder.content).toBe("SimpleRepo docs at branch main is a folder with 2 entries:\n/docs/prd.md\n/docs/adr/0001.md");
    expect((await s.call(TOOL_NAMES.getFile, { repository: "SimpleRepo", path: "nope.md" }, "ladon")).error).toBe("nope.md was not found in SimpleRepo at branch main.");

    s.ado.files.set("main", { "/big.txt": Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join("\n") });
    const first = await s.call(TOOL_NAMES.getFile, { repository: "SimpleRepo", path: "big.txt" }, "ladon");
    expect(first.content).toContain("lines 1-2000 of 2500");
    expect(first.content).toContain("(500 more lines: call again with startLine 2001.)");
    expect((await s.call(TOOL_NAMES.getFile, { repository: "SimpleRepo", path: "big.txt", startLine: 2001 }, "ladon")).content).toContain(" 2500  l2500");
  });

  it("ado_get_pr_changes lists a pull request's files and diffs one against the merge base (A8)", async () => {
    const s = setup();
    s.ado.prs.set(7, { id: 7, title: "#42 Story", status: "active", source: "ai/42-story", target: "main", threads: [] } as never);
    s.ado.prChanges = [
      { changeType: "edit", item: { path: "/README.md" } },
      { changeType: "add", item: { path: "/smoke/hello.txt" } },
      { changeType: "edit", item: { path: "/src", isFolder: true } },
    ];
    s.ado.files.set("base", { "/README.md": "a\nb\nc\n" });
    s.ado.files.set("src", { "/README.md": "a\nB\nc\n", "/smoke/hello.txt": "Hello\n" });
    const list = await s.call(TOOL_NAMES.getPullRequestChanges, { pullRequestId: 7 }, "ladon");
    expect(list.content).toBe('Pull request 7 "#42 Story" (active) in SimpleRepo, ai/42-story into main, 2 files changed:\n- edit: /README.md\n- add: /smoke/hello.txt');
    const edit = await s.call(TOOL_NAMES.getPullRequestChanges, { pullRequestId: 7, filePath: "README.md" }, "ladon");
    expect(edit.content).toContain("--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
    const added = await s.call(TOOL_NAMES.getPullRequestChanges, { pullRequestId: 7, filePath: "/smoke/hello.txt" }, "ladon");
    expect(added.content).toContain("@@ -0,0 +1,1 @@\n+Hello");
    expect((await s.call(TOOL_NAMES.getPullRequestChanges, { pullRequestId: 7, filePath: "other.md" }, "ladon")).error).toMatch(/is not among the files/);
  });

  it("ado_search_work_items finds items by title text, with type and state filters quoted safely (A8)", async () => {
    const s = setup();
    s.ado.add(60, "Feature", "New");
    s.ado.items.get(60)!.fields["System.Title"] = "Greeting file";
    const res = await s.call(TOOL_NAMES.searchWorkItems, { text: "greeting", type: "Feature", state: "New" }, "ladon");
    expect(res.content).toBe('1 work item with "greeting" in the title:\n- #60 Feature (New): Greeting file');
    expect(s.ado.wiqlQueries.at(-1)).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Title] CONTAINS 'greeting' AND [System.WorkItemType] = 'Feature' AND [System.State] = 'New' ORDER BY [System.ChangedDate] DESC",
    );
    await s.call(TOOL_NAMES.searchWorkItems, { text: "it's" }, "ladon");
    expect(s.ado.wiqlQueries.at(-1)).toContain("CONTAINS 'it''s'");
  });

  it("builderRole and forAgent (A6) tag new items for the router, only on the types they fit", async () => {
    const s = setup();
    const tagsOf = (i: number) => (s.ado.writes()[i]!.body as Array<{ path: string; value: unknown }>).find((o) => o.path === "/fields/System.Tags")?.value;
    s.ado.add(31, "Feature", "Refining");
    const story = await s.call(TOOL_NAMES.createWorkItem, { parentId: 31, type: "User Story", title: "s", builderRole: "backend" }, "tiamat");
    expect(story.error).toBeUndefined();
    expect(tagsOf(0)).toBe("agent:Tiamat; builder:backend");
    expect(story.data).toMatchObject({ builderRole: "backend" });
    const review = await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Review", title: "r", forAgent: "ladon" }, "tiamat");
    expect(tagsOf(1)).toBe("agent:Tiamat; for:Ladon");
    expect(review.data).toMatchObject({ forAgent: "Ladon" });
    expect((await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Review", title: "r", builderRole: "x" }, "tiamat")).error).toMatch(/builderRole is only for a User Story or Bug/);
    expect((await s.call(TOOL_NAMES.createWorkItem, { parentId: 31, type: "User Story", title: "s", forAgent: "Ladon" }, "tiamat")).error).toMatch(/forAgent is only for a Review, QA Test or Task/);
    expect((await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Review", title: "r", forAgent: "Nobody" }, "tiamat")).error).toMatch(/no agent called "Nobody"/);
    expect(s.ado.writes()).toHaveLength(2);
  });

  it("instructions: extraction and the types that do not take them", () => {
    expect(extractInstructions("<div>Intro</div><div>Instructions from Josh: be brief</div>")).toBe("be brief");
    expect(extractInstructions("No instructions here")).toBeNull();
    expect(extractInstructions(undefined)).toBeNull();
    const epic = { id: 1, rev: 1, url: "", fields: { "System.Description": "Instructions from Josh:<br>x" } };
    expect(instructionsToCarry("Defect", null, [epic])).toEqual([]);
    expect(instructionsToCarry("Task", null, [epic])).toEqual([{ sourceId: 1, text: "x" }]);
    expect(withInstructions(null, [{ sourceId: 1, text: "x" }])).toBe("Instructions from Josh (copied from #1):\nx");
  });

  it("ado_create_work_item writes acceptance criteria, and refuses them for a type without the field", async () => {
    const s = setup();
    const res = await s.call(
      TOOL_NAMES.createWorkItem,
      { type: "Epic", title: "Add a line", acceptanceCriteria: "README has the line\nNothing else changes" },
      "tiamat",
    );
    expect(res.error).toBeUndefined();
    expect(s.ado.writes()[0]!.body).toContainEqual({
      op: "add",
      path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria",
      value: "README has the line<br>Nothing else changes",
    });
    const before = s.ado.writes().length;
    const task = await s.call(TOOL_NAMES.createWorkItem, { parentId: 42, type: "Task", title: "x", acceptanceCriteria: "y" }, "ryujin");
    expect(task.error).toBe("Nothing was created: a Task has no acceptance criteria field; put the criteria in the description.");
    expect(s.ado.writes().length).toBe(before);
  });

  describe("default work item", () => {
    it("uses the work item linked to the run's task when no ID is given", async () => {
      const s = setup();
      const res = await s.call(TOOL_NAMES.getWorkItem, {}, "ryujin", "run-with-task");
      expect((res.data as any).id).toBe(42);
      const child = await s.call(TOOL_NAMES.createWorkItem, { type: "Task", title: "x" }, "ryujin", "run-with-task");
      expect(child.data).toMatchObject({ parentId: 42 });
    });

    it("does not remember a miss, and prefers the task whose execution run matches", async () => {
      const s = setup();
      expect((await s.call(TOOL_NAMES.getWorkItem, {}, "ryujin", "run-late")).error).toMatch(/not working on a task/);
      s.harness.seed({
        issues: [
          { id: "issue-checkout", companyId: CO, assigneeAgentId: AGENTS.ryujin.id, status: "in_progress", executionRunId: null, checkoutRunId: "run-late", title: "t" },
          { id: "issue-3", companyId: CO, assigneeAgentId: AGENTS.ryujin.id, status: "todo", executionRunId: "run-late", checkoutRunId: null, title: "t" },
        ] as never,
      });
      expect(((await s.call(TOOL_NAMES.getWorkItem, {}, "ryujin", "run-late")).data as any).id).toBe(42);
      await s.call(TOOL_NAMES.addComment, { text: "x" }, "ryujin", "run-late");
      expect(s.harness.activity[0]).toMatchObject({ entityId: "issue-3" });
    });

    it("asks for an ID when the run has no task, or the task has no link", async () => {
      const s = setup();
      expect((await s.call(TOOL_NAMES.getWorkItem, {}, "ryujin", "run-without-task")).error).toBe(
        "No workItemId was given and this run is not working on a task, so there is no default work item. Pass workItemId.",
      );
      expect((await s.call(TOOL_NAMES.getWorkItem, {}, "ryujin", "run-unlinked")).error).toBe(
        "No workItemId was given and your current task is not linked to an ADO work item. Pass workItemId.",
      );
      expect(s.ado.requests).toHaveLength(0);
    });
  });

  it("validates parameters with a readable message", async () => {
    const s = setup();
    expect((await s.call(TOOL_NAMES.addComment, { workItemId: 42, text: "  " })).error).toBe("text is required and must be non-empty text.");
    expect((await s.call(TOOL_NAMES.getWorkItem, { workItemId: -1 })).error).toBe("workItemId must be a positive whole number.");
  });
});

describe("registration through the worker", () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("registers all tools and reports an unconfigured company clearly", async () => {
    const harness = createTestHarness({ manifest, config: {} });
    harness.seed({ agents: [AGENTS.tiamat] as never });
    await createAdoPlugin({ recoveryDelayMs: 0 }).definition.setup(harness.ctx);
    const res = await harness.executeTool<ToolResult>(TOOL_NAMES.getWorkItem, { workItemId: 1 }, { agentId: AGENTS.tiamat.id, companyId: CO });
    expect(res.error).toBe("Azure DevOps is not available: The Azure DevOps plugin is not configured for this company");
  });
});
