import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { AdoClient } from "../src/ado/client.js";
import type { PluginDeps } from "../src/deps.js";
import type { AdoLink, LinkFeatures } from "../src/links/index.js";
import { registerAgentTools } from "../src/tools/index.js";
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
  ],
};

interface FakeItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  relations: Array<{ rel: string; url: string; attributes?: Record<string, unknown> }>;
}

/** A small in-memory ADO that speaks the REST calls the tools make. */
class FakeAdo {
  items = new Map<number, FakeItem>();
  comments = new Map<number, Array<{ id: number; text: string; createdBy: { displayName: string }; createdDate: string }>>();
  requests: Array<{ method: string; url: string; body?: unknown; contentType?: string }> = [];
  throttle = false;
  /** Answer every request with this status (and optional Retry-After). */
  failWith: { status: number; retryAfter?: string } | null = null;
  nextId = 500;

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
          else if (op.path.startsWith("/fields/")) item.fields[op.path.slice(8)] = op.value;
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
    if ((m = path.match(/^\/_apis\/wit\/workitemtypes\/(.+)\/states$/))) {
      return Response.json({ value: ["New", "Active", "Resolved", "Closed", "Removed"].map((name) => ({ name, category: "x" })) });
    }
    if ((m = path.match(/^\/_apis\/git\/repositories\/([^/]+)$/))) {
      if (decodeURIComponent(m[1]!) !== "SimpleRepo") return Response.json({ message: "repo not found" }, { status: 404 });
      return Response.json({ id: REPO_ID, name: "SimpleRepo", project: { id: PROJECT_ID } });
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

function setup(opts: { links?: Record<string, number>; config?: Record<string, unknown> } = {}): Setup {
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
  const links: LinkFeatures = {
    async findLinkByIssue(_companyId, issueId) {
      return issueId in linkMap ? link(issueId, linkMap[issueId]!) : null;
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

  it("only planners and builders write structure; readonly only reads", () => {
    expect(ROLE_POLICIES.readonly.tools).toEqual([TOOL_NAMES.getWorkItem]);
    expect(ROLE_POLICIES.reviewer.tools).not.toContain(TOOL_NAMES.createChildWorkItem);
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
      expect([t.name, hostToolRisk(t.name)]).toEqual([t.name, t.name === TOOL_NAMES.getWorkItem ? "read" : "write"]);
      expect(hostToolRisk(namespaced)).toBe(hostToolRisk(t.name));
    }
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
    expect(roles.items.properties.role.enum).toEqual(["readonly", "builder", "reviewer", "planner"]);
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
    expect(await client.getWorkItemTypeStates("User Story")).toContainEqual({ name: "Active", category: "x" });
    expect(await client.getRepository("SimpleRepo")).toEqual({ id: REPO_ID, name: "SimpleRepo", projectId: PROJECT_ID });
    expect((await client.getPullRequest(REPO_ID, 5)).title).toBe("Add feature");
    const [list, add, patch, create, states] = ado.requests;
    expect(list!.url).toBe(`${ORG}/AI%20Testing/_apis/wit/workItems/42/comments?$top=3&order=desc&api-version=7.1-preview.4`);
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
      expect(denied.error).toMatch(/^Permission denied: Stranger has the ADO role "readonly", which allows only ado_get_work_item\./);
      expect(s.ado.writes()).toHaveLength(0);
      expect(s.harness.activity).toHaveLength(0);
    });

    it("reviewers may comment and set state but not link PRs or create items", async () => {
      const s = setup();
      expect((await s.call(TOOL_NAMES.addComment, { workItemId: 42, text: "ok" }, "ladon")).error).toBeUndefined();
      expect((await s.call(TOOL_NAMES.linkPullRequest, { workItemId: 42, repository: "SimpleRepo", pullRequestId: 5 }, "ladon")).error).toMatch(/Permission denied/);
      expect((await s.call(TOOL_NAMES.createChildWorkItem, { parentId: 42, type: "Task", title: "x" }, "ladon")).error).toMatch(/Permission denied/);
    });

    it("builders may create Tasks only; planners any type", async () => {
      const s = setup();
      const feature = await s.call(TOOL_NAMES.createChildWorkItem, { parentId: 42, type: "Feature", title: "x" }, "ryujin");
      expect(feature.error).toBe("Your ADO role (builder) may not create Feature work items; it may create: Task.");
      expect((await s.call(TOOL_NAMES.createChildWorkItem, { parentId: 42, type: "Bug", title: "x" }, "ryujin")).error).toMatch(/may not create Bug/);
      expect(s.ado.writes()).toHaveLength(0);
      expect((await s.call(TOOL_NAMES.createChildWorkItem, { parentId: 42, type: "task", title: "x" }, "ryujin")).error).toBeUndefined();
      expect((await s.call(TOOL_NAMES.createChildWorkItem, { parentId: 42, type: "Feature", title: "x" }, "tiamat")).error).toBeUndefined();
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
      expect(res.error).toBe('"Doing" is not a state of User Story. Valid states: New, Active, Resolved, Closed, Removed.');
      expect(s.ado.writes()).toHaveLength(0);
    });

    it("patches with test /rev first, attributes the history and caches the type's states", async () => {
      const s = setup();
      const res = await s.call(TOOL_NAMES.setState, { workItemId: 42, state: "active", comment: "Starting work" });
      expect(res.content).toBe("Work item #42 moved from New to Active.");
      const patch = s.ado.writes()[0]!;
      expect(patch.body).toEqual([
        { op: "test", path: "/rev", value: 7 },
        { op: "replace", path: "/fields/System.State", value: "Active" },
        { op: "add", path: "/fields/System.History", value: "[Tiamat] Changed state from New to Active.<br>Starting work" },
        { op: "add", path: "/fields/System.Tags", value: "agent:Tiamat" },
      ]);
      expect(s.harness.activity[0]).toMatchObject({ message: "[Tiamat] moved ADO #42 from New to Active", metadata: { from: "New", to: "Active" } });

      await s.call(TOOL_NAMES.setState, { workItemId: 42, state: "Resolved" });
      expect(s.ado.requests.filter((r) => r.url.includes("/states")).length).toBe(1);
      expect((await s.call(TOOL_NAMES.setState, { workItemId: 42, state: "Resolved" })).content).toMatch(/already Resolved/);
    });

    it("tells the agent to re-read when the item changed underneath it", async () => {
      const s = setup();
      const realFetch = s.ado.fetch;
      // Someone edits the item between our read and our write.
      s.ado.fetch = async (input, init) => {
        if (init?.method === "PATCH") s.ado.items.get(42)!.rev = 99;
        return realFetch(input, init);
      };
      const res = await s.call(TOOL_NAMES.setState, { workItemId: 42, state: "Active" });
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

  it("ado_create_child_work_item links the parent and inherits its area and iteration", async () => {
    const s = setup();
    const res = await s.call(TOOL_NAMES.createChildWorkItem, { parentId: 42, type: "Task", title: "Write tests", description: "a < b\nc" }, "ryujin");
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

  describe("default work item", () => {
    it("uses the work item linked to the run's task when no ID is given", async () => {
      const s = setup();
      const res = await s.call(TOOL_NAMES.getWorkItem, {}, "ryujin", "run-with-task");
      expect((res.data as any).id).toBe(42);
      const child = await s.call(TOOL_NAMES.createChildWorkItem, { type: "Task", title: "x" }, "ryujin", "run-with-task");
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
