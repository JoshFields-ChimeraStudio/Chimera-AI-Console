import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, pluginDatabaseNamespaces, pluginMigrations, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { derivePluginDatabaseNamespace } from "../services/plugin-database.js";
import { reconcileShippedPlugins, type ShippedPluginSource } from "../services/shipped-plugins.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Real loader, registry, lifecycle and plugin migrations against PostgreSQL:
// the payload copies a managed git install ships, across install, update,
// rollback and adoption of a hand-made install.

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

const PACKAGE_NAME = "@chimera/plugin-shipfix";
const PLUGIN_KEY = "chimera.plugin-shipfix";
const OTHER_KEY = "chimera.not-shipped";
const DIR = "packages/plugins/plugin-shipfix";
const NAMESPACE = derivePluginDatabaseNamespace(PLUGIN_KEY, "shipfix");

function fixtureManifest(id: string, version: string, extraCapabilities: string[] = []): PaperclipPluginManifestV1 {
  return {
    id,
    apiVersion: 1,
    version,
    displayName: "Shipped fixture",
    description: "Shipped plugin fixture",
    author: "Chimera",
    categories: ["connector"],
    capabilities: ["database.namespace.migrate", "database.namespace.read", "database.namespace.write", ...extraCapabilities],
    entrypoints: { worker: "./dist/worker.js" },
    database: { namespaceSlug: "shipfix", migrationsDir: "migrations", coreReadTables: [] },
  } as PaperclipPluginManifestV1;
}

describePostgres("shipped plugin reconcile in PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("shipped-plugins-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterEach(async () => {
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`));
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${derivePluginDatabaseNamespace(OTHER_KEY, "shipfix")}" CASCADE`));
    await db.delete(pluginMigrations);
    await db.delete(pluginDatabaseNamespaces);
    await db.delete(plugins);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  afterAll(async () => { await database?.cleanup(); });

  /** A payload: `<root>/shipped-plugins.json` plus a built copy at `<root>/<DIR>`. */
  function payload(version: string, opts: { migrations?: number; extraCapabilities?: string[]; id?: string; name?: string } = {}) {
    const root = mkdtempSync(path.join(os.tmpdir(), "shipped-payload-"));
    roots.push(root);
    const name = opts.name ?? PACKAGE_NAME;
    const dir = path.join(root, DIR);
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    mkdirSync(path.join(dir, "migrations"), { recursive: true });
    const manifest = fixtureManifest(opts.id ?? PLUGIN_KEY, version, opts.extraCapabilities);
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name, version, type: "module", files: ["dist", "migrations"],
      paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
    }));
    writeFileSync(path.join(dir, "dist", "manifest.js"), `export default ${JSON.stringify(manifest)};\n`);
    writeFileSync(path.join(dir, "dist", "worker.js"), `console.log(${JSON.stringify(`worker ${version} from ${root}`)});\n`);
    for (let index = 1; index <= (opts.migrations ?? 1); index += 1) {
      writeFileSync(path.join(dir, "migrations", `00${index}_t${index}.sql`), `CREATE TABLE ${derivePluginDatabaseNamespace(manifest.id, "shipfix")}.t${index} (id integer);\n`);
    }
    writeFileSync(path.join(root, "shipped-plugins.json"), JSON.stringify([{ dir: DIR, name }]));
    const source: ShippedPluginSource = { kind: "payload", root, listPath: path.join(root, "shipped-plugins.json") };
    return { root, dir, source, manifest };
  }

  function services() {
    const output: string[] = [];
    const runtime = {
      workerManager: {
        startWorker: vi.fn(async (_id: string, options: { entrypointPath: string }) => {
          output.push(execFileSync(process.execPath, [options.entrypointPath], { encoding: "utf8" }).trim());
        }),
        call: vi.fn(async () => ({})),
        isRunning: vi.fn(() => false),
      },
      lifecycleManager: { markError: vi.fn() },
      jobStore: { syncJobDeclarations: vi.fn() },
      jobScheduler: { registerPlugin: vi.fn() },
      toolDispatcher: {},
      eventBus: { forPlugin: vi.fn(), subscriptionCount: vi.fn(() => 0) },
      buildHostHandlers: vi.fn(() => ({})),
      instanceInfo: { instanceId: "fixture", hostVersion: "1.0.0" },
    };
    return { runtime, output };
  }

  /** One server boot: reconcile with the boot-time loader, then activate (as loadAll would). */
  async function boot(source: ShippedPluginSource) {
    const registry = pluginRegistryService(db);
    const localPluginDir = mkdtempSync(path.join(os.tmpdir(), "shipped-home-"));
    roots.push(localPluginDir);
    const loader = pluginLoader(db, { localPluginDir, migrationDb: db });
    const lifecycle = pluginLifecycleManager(db, {});
    const outcomes = await reconcileShippedPlugins(source, { registry, loader, lifecycle, logger: { info() {}, warn() {}, error() {} } });
    const row = await registry.getByKey(PLUGIN_KEY);
    const { runtime, output } = services();
    const activated = row ? await pluginLoader(db, { localPluginDir, migrationDb: db }, runtime as unknown as PluginRuntimeServices).loadSingle(row.id) : null;
    return { outcomes, row, activated, output, registry };
  }

  async function appliedMigrations() {
    const rows = await db.select().from(pluginMigrations);
    return rows.map((row) => row.migrationKey).sort();
  }

  it("installs, rebinds on update, and rebinds back on rollback, with forward-only migrations", async () => {
    const first = payload("0.1.0");
    const second = payload("0.2.0", { migrations: 2, extraCapabilities: ["issues.read"] });

    const installed = await boot(first.source);
    expect(installed.outcomes).toEqual([{ name: PACKAGE_NAME, pluginKey: PLUGIN_KEY, action: "installed" }]);
    expect(installed.row).toMatchObject({ status: "ready", version: "0.1.0", packagePath: first.dir, packageName: PACKAGE_NAME });
    expect(installed.activated?.success).toBe(true);
    expect(installed.output).toEqual([`worker 0.1.0 from ${first.root}`]);
    expect(await appliedMigrations()).toHaveLength(1);

    const updated = await boot(second.source);
    expect(updated.outcomes[0]?.action).toBe("rebound");
    expect(updated.row).toMatchObject({ id: installed.row!.id, status: "ready", version: "0.2.0", packagePath: second.dir });
    expect(updated.row?.manifestJson.capabilities).toContain("issues.read");
    expect(updated.activated?.success).toBe(true);
    expect(updated.output).toEqual([`worker 0.2.0 from ${second.root}`]);
    expect(await appliedMigrations()).toHaveLength(2);

    rmSync(first.root, { recursive: true, force: true });
    const pruned = payload("0.1.0");
    const rolledBack = await boot(pruned.source);
    expect(rolledBack.outcomes[0]?.action).toBe("rebound");
    expect(rolledBack.row).toMatchObject({ id: installed.row!.id, status: "ready", version: "0.1.0", packagePath: pruned.dir });
    expect(rolledBack.activated?.success).toBe(true);
    expect(rolledBack.output).toEqual([`worker 0.1.0 from ${pruned.root}`]);
    // Forward-only: the newer migration stays applied after a rollback.
    expect(await appliedMigrations()).toHaveLength(2);

    const again = await boot(pruned.source);
    expect(again.outcomes[0]?.action).toBe("unchanged");
  });

  it("adopts a hand-made install of the same plugin key and leaves other plugins alone", async () => {
    const manual = payload("0.1.0");
    const other = payload("3.0.0", { id: OTHER_KEY, name: "@chimera/not-shipped" });
    const registry = pluginRegistryService(db);
    const localPluginDir = mkdtempSync(path.join(os.tmpdir(), "shipped-home-"));
    roots.push(localPluginDir);
    const loader = pluginLoader(db, { localPluginDir, migrationDb: db });
    // What the plugin manager's "install from local path" does.
    await loader.installPlugin({ localPath: manual.dir });
    await loader.installPlugin({ localPath: other.dir });
    const manualRow = (await registry.getByKey(PLUGIN_KEY))!;
    await registry.updateStatus(manualRow.id, { status: "upgrade_pending" });
    const otherBefore = (await registry.getByKey(OTHER_KEY))!;

    const shipped = payload("0.2.0", { migrations: 2 });
    const booted = await boot(shipped.source);
    expect(booted.outcomes[0]?.action).toBe("rebound");
    expect(booted.row).toMatchObject({ id: manualRow.id, status: "ready", version: "0.2.0", packagePath: shipped.dir });
    expect(await db.select().from(plugins).where(eq(plugins.pluginKey, PLUGIN_KEY))).toHaveLength(1);
    expect(booted.activated?.success).toBe(true);
    expect(await registry.getByKey(OTHER_KEY)).toEqual(otherBefore);
  });
});
