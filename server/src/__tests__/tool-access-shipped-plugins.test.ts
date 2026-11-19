// Chimera fork: tools of shipped plugins (scripts/shipped-plugins.json) are
// allowed for agents by default, after blocks, require-approval policies and
// profile exclude entries have had their say.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  plugins,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { setShippedPluginKeysForTest } from "../services/shipped-plugins.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TOOL_POLICY_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type DecisionInput = Parameters<ReturnType<typeof toolAccessPolicyService>["decide"]>[0];

describeEmbeddedPostgres("tool access for shipped plugins", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (externalDatabaseUrl) db = createDb(externalDatabaseUrl);
    else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-access-shipped-");
      db = createDb(tempDb.connectionString);
    }
  }, 20_000);

  afterEach(() => setShippedPluginKeysForTest([]));

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function fixture(options: { shippedStatus?: "ready" | "disabled" } = {}) {
    const company = await db.insert(companies).values({
      name: `Shipped ${randomUUID()}`,
      issuePrefix: `SP${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning().then((rows) => rows[0]!);
    const suffix = randomUUID().slice(0, 8);
    const insertPlugin = (pluginKey: string, status: "ready" | "disabled", packagePath = `/srv/plugins/${pluginKey}`) =>
      db.insert(plugins).values({
        pluginKey,
        packageName: pluginKey,
        packagePath,
        version: "0.1.0",
        status,
        manifestJson: { id: pluginKey } as never,
      }).returning().then((rows) => rows[0]!);
    const shipped = await insertPlugin(`chimera.shipped-${suffix}`, options.shippedStatus ?? "ready");
    const manual = await insertPlugin(`acme.manual-${suffix}`, "ready");
    setShippedPluginKeysForTest([[shipped.pluginKey, shipped.packagePath!]]);
    return { company, agent, shipped, manual };
  }

  function pluginToolInput(
    f: Awaited<ReturnType<typeof fixture>>,
    plugin: { id: string; pluginKey: string },
    toolName = `${plugin.pluginKey}:get_item`,
  ): DecisionInput {
    return {
      companyId: f.company.id,
      actor: { actorType: "agent", actorId: f.agent.id, agentId: f.agent.id },
      request: { providerType: "paperclip_plugin", pluginId: plugin.id, toolName, riskLevel: "write", arguments: {} },
    };
  }

  it("does not trust a same-key plugin installed from a different package path", async () => {
    const f = await fixture();
    await db.update(plugins).set({ packagePath: "/tmp/someone-elses-package" }).where(eq(plugins.id, f.shipped.id));
    const result = await toolAccessPolicyService(db).decide(pluginToolInput(f, f.shipped));
    expect(result).toMatchObject({ allowed: false, reasonCode: "deny_default" });
  });

  it("allows a shipped plugin's tool for agents by default", async () => {
    const f = await fixture();
    const result = await toolAccessPolicyService(db).decide(pluginToolInput(f, f.shipped));
    expect(result).toMatchObject({ allowed: true, decision: "allow", reasonCode: "allow_shipped_plugin" });
    expect(result.explanation).toContain(f.shipped.pluginKey);
  });

  it("keeps deny_default for a plugin that is not on the shipped list", async () => {
    const f = await fixture();
    const result = await toolAccessPolicyService(db).decide(pluginToolInput(f, f.manual));
    expect(result).toMatchObject({ allowed: false, reasonCode: "deny_default" });
  });

  it("keeps deny_default for a shipped plugin that is not ready", async () => {
    const f = await fixture({ shippedStatus: "disabled" });
    const result = await toolAccessPolicyService(db).decide(pluginToolInput(f, f.shipped));
    expect(result).toMatchObject({ allowed: false, reasonCode: "deny_default" });
  });

  it("does not lend a shipped plugin's identity to a tool outside its namespace", async () => {
    const f = await fixture();
    const result = await toolAccessPolicyService(db).decide(pluginToolInput(f, f.shipped, `${f.manual.pluginKey}:get_item`));
    expect(result).toMatchObject({ allowed: false, reasonCode: "deny_default" });
  });

  it("keeps deny_default for non-agent actors", async () => {
    const f = await fixture();
    const input = pluginToolInput(f, f.shipped);
    const result = await toolAccessPolicyService(db).decide({ ...input, actor: { actorType: "system", actorId: f.company.id, agentId: null } });
    expect(result).toMatchObject({ allowed: false, reasonCode: "deny_default" });
  });

  it("lets an explicit block policy deny a shipped plugin's tool", async () => {
    const f = await fixture();
    const toolName = `${f.shipped.pluginKey}:get_item`;
    await db.insert(toolPolicies).values({
      companyId: f.company.id,
      name: "Block it",
      policyType: "block",
      selectors: { toolName },
    });
    const result = await toolAccessPolicyService(db).decide(pluginToolInput(f, f.shipped));
    expect(result).toMatchObject({ allowed: false, decision: "deny", reasonCode: "deny_policy_block" });
  });

  it("lets a require-approval policy require approval for a shipped plugin's tool", async () => {
    const f = await fixture();
    await db.insert(toolPolicies).values({
      companyId: f.company.id,
      name: "Ask first",
      policyType: "require_approval",
      selectors: { toolName: `${f.shipped.pluginKey}:get_item` },
    });
    const result = await toolAccessPolicyService(db).decide(pluginToolInput(f, f.shipped));
    expect(result).toMatchObject({ allowed: false, decision: "require_approval", reasonCode: "requires_approval_policy" });
  });

  it("lets a profile exclude entry deny a shipped plugin's tool", async () => {
    const f = await fixture();
    const profile = await db.insert(toolProfiles).values({
      companyId: f.company.id,
      profileKey: `profile-${randomUUID()}`,
      name: "No ADO writes",
      defaultAction: "deny",
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolProfileBindings).values({ companyId: f.company.id, profileId: profile.id, targetType: "agent", targetId: f.agent.id });
    await db.insert(toolProfileEntries).values({
      companyId: f.company.id,
      profileId: profile.id,
      selectorType: "tool_name",
      effect: "exclude",
      toolName: `${f.shipped.pluginKey}:get_item`,
    });
    const result = await toolAccessPolicyService(db).decide(pluginToolInput(f, f.shipped));
    expect(result).toMatchObject({ allowed: false, reasonCode: "deny_default", effectiveProfileIds: [profile.id] });
  });

  function dispatcherFor(tools: Array<{ name: string; pluginId: string }>, executed: string[] = []): PluginToolDispatcher {
    return {
      initialize: async () => {},
      teardown: () => {},
      listToolsForAgent: () => tools.map((tool) => ({
        name: tool.name,
        displayName: tool.name,
        description: "Fixture tool.",
        parametersSchema: { type: "object" },
        pluginId: tool.pluginId,
      })),
      getTool: () => null,
      executeTool: async (name) => {
        executed.push(name);
        return { pluginId: "fixture", toolName: name, result: { content: "ok" } };
      },
      registerPluginTools: () => {},
      unregisterPluginTools: () => {},
      toolCount: () => tools.length,
      getRegistry: () => {
        throw new Error("not implemented");
      },
    };
  }

  it("lists a shipped plugin's tool for agents and hides a non-shipped plugin's tool", async () => {
    const f = await fixture();
    const shippedTool = `${f.shipped.pluginKey}:get_item`;
    const manualTool = `${f.manual.pluginKey}:get_item`;
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "test-secret",
      pluginToolDispatcher: dispatcherFor([
        { name: shippedTool, pluginId: f.shipped.id },
        { name: manualTool, pluginId: f.manual.id },
      ]),
    });
    const listed = await gateway.listPluginToolsForAgent({ companyId: f.company.id, agentId: f.agent.id });
    expect(listed.map((tool) => tool.name)).toEqual([shippedTool]);
  });

  it("executes a shipped plugin's tool and denies a non-shipped one through the plugin tool route", async () => {
    const f = await fixture();
    const issue = await db.insert(issues).values({ companyId: f.company.id, title: "Shipped tool", status: "in_progress", assigneeAgentId: f.agent.id })
      .returning().then((rows) => rows[0]!);
    const run = await db.insert(heartbeatRuns).values({
      companyId: f.company.id,
      agentId: f.agent.id,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: issue.id },
    }).returning().then((rows) => rows[0]!);
    const shippedTool = `${f.shipped.pluginKey}:get_item`;
    const manualTool = `${f.manual.pluginKey}:get_item`;
    const executed: string[] = [];
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "test-secret",
      pluginToolDispatcher: dispatcherFor([
        { name: shippedTool, pluginId: f.shipped.id },
        { name: manualTool, pluginId: f.manual.id },
      ], executed),
    });
    const call = (tool: string) => gateway.executePluginTool({
      actor: { type: "agent", companyId: f.company.id, agentId: f.agent.id, runId: run.id },
      tool,
      parameters: {},
      runContext: { companyId: f.company.id, agentId: f.agent.id, runId: run.id, projectId: "" },
    });

    await call(shippedTool);
    expect(executed).toEqual([shippedTool]);
    await expect(call(manualTool)).rejects.toMatchObject({ status: 403, reasonCode: "deny_default" });
    expect(executed).toEqual([shippedTool]);
  });
});
