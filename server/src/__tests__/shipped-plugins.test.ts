import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  SERVER_PACKAGE_ROOT,
  ensureShippedPlugins,
  readShippedPlugins,
  reconcileShippedPlugins,
  resolveShippedPluginSource,
  type ShippedPlugin,
  type ShippedPluginReconcileDeps,
} from "../services/shipped-plugins.js";

const tempDirs: string[] = [];
function makeTempDir(prefix = "shipped-plugins-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const PLUGIN_NAME = "@chimera/plugin-ado";
const PLUGIN_KEY = "chimera.plugin-ado";
const PLUGIN_DIR = "packages/plugins/plugin-ado";

function manifest(version: string, capabilities: string[] = ["events.subscribe"]): PaperclipPluginManifestV1 {
  return {
    id: PLUGIN_KEY,
    apiVersion: 1,
    version,
    displayName: "ADO",
    description: "test",
    author: "test",
    categories: ["connector"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  } as unknown as PaperclipPluginManifestV1;
}

/** A built plugin copy on disk, as the payload or the repository holds it. */
function writePluginCopy(root: string, opts: { name?: string; built?: boolean } = {}): string {
  const dir = path.join(root, PLUGIN_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: opts.name ?? PLUGIN_NAME, version: "0.1.0" }));
  if (opts.built !== false) {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, "dist", "manifest.js"), "export default {}");
  }
  return dir;
}

interface Row {
  id: string;
  pluginKey: string;
  packageName: string;
  packagePath: string | null;
  status: string;
  version: string;
  manifestJson: PaperclipPluginManifestV1;
  lastError?: string | null;
}

/**
 * In-memory registry/loader/lifecycle. `manifests` maps a package root to the
 * manifest its dist/manifest.js would export.
 */
function harness(rows: Row[], manifests: Map<string, PaperclipPluginManifestV1>) {
  const byKey = new Map(rows.map((row) => [row.pluginKey, row]));
  const calls: string[] = [];
  const deps: ShippedPluginReconcileDeps = {
    registry: {
      getByKey: vi.fn(async (key: string) => {
        calls.push(`getByKey:${key}`);
        const row = byKey.get(key);
        return row ? { ...row } : null;
      }),
      update: vi.fn(async (id: string, data) => {
        const row = [...byKey.values()].find((candidate) => candidate.id === id)!;
        calls.push(`update:${row.pluginKey}`);
        if (data.packagePath !== undefined) row.packagePath = data.packagePath;
        if (data.packageName !== undefined) row.packageName = data.packageName;
        if (data.version !== undefined) row.version = data.version;
        if (data.manifest !== undefined) row.manifestJson = data.manifest;
        return row;
      }),
      updateStatus: vi.fn(async (id: string, input) => {
        const row = [...byKey.values()].find((candidate) => candidate.id === id)!;
        calls.push(`updateStatus:${row.pluginKey}:${input.status}`);
        row.status = input.status;
        row.lastError = input.lastError;
        return row;
      }),
    },
    loader: {
      loadManifest: vi.fn(async (packagePath: string) => {
        if (!existsSync(path.join(packagePath, "dist", "manifest.js"))) return null;
        return manifests.get(packagePath) ?? null;
      }),
      installPlugin: vi.fn(async ({ localPath }: { localPath: string }) => {
        const m = manifests.get(localPath)!;
        calls.push(`install:${m.id}`);
        const existing = byKey.get(m.id);
        if (existing && existing.status !== "uninstalled") throw new Error(`Plugin already installed: ${m.id}`);
        const row: Row = existing ?? { id: `id-${m.id}`, pluginKey: m.id, packageName: "", packagePath: null, status: "", version: "", manifestJson: m };
        Object.assign(row, { packageName: PLUGIN_NAME, packagePath: localPath, status: "installed", version: m.version, manifestJson: m });
        byKey.set(m.id, row);
        return { manifest: { id: m.id } };
      }),
    },
    lifecycle: {
      load: vi.fn(async (id: string) => {
        const row = [...byKey.values()].find((candidate) => candidate.id === id)!;
        calls.push(`load:${row.pluginKey}`);
        row.status = "ready";
        return row;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { deps, rows: byKey, calls };
}

function shipped(localPath: string): ShippedPlugin[] {
  return [{ name: PLUGIN_NAME, dir: PLUGIN_DIR, localPath }];
}

function adoRow(overrides: Partial<Row>): Row {
  return {
    id: "ado-row",
    pluginKey: PLUGIN_KEY,
    packageName: PLUGIN_NAME,
    packagePath: null,
    status: "ready",
    version: "0.1.0",
    manifestJson: manifest("0.1.0"),
    ...overrides,
  };
}

const OTHER_ROW: Row = {
  id: "other-row",
  pluginKey: "paperclip.workspace-diff",
  packageName: "@paperclipai/plugin-workspace-diff",
  packagePath: "/somewhere/else",
  status: "error",
  version: "1.0.0",
  manifestJson: { ...manifest("1.0.0"), id: "paperclip.workspace-diff" },
};

describe("resolveShippedPluginSource", () => {
  it("prefers the copies staged inside the server package (managed git install payload)", () => {
    const serverPackageRoot = makeTempDir();
    mkdirSync(path.join(serverPackageRoot, "shipped-plugins"));
    writeFileSync(path.join(serverPackageRoot, "shipped-plugins", "shipped-plugins.json"), "[]");
    expect(resolveShippedPluginSource({ serverPackageRoot })).toEqual({
      kind: "payload",
      root: path.join(serverPackageRoot, "shipped-plugins"),
      listPath: path.join(serverPackageRoot, "shipped-plugins", "shipped-plugins.json"),
    });
  });

  it("falls back to the repository list (Docker /app and dev runs)", () => {
    const repoRoot = makeTempDir();
    mkdirSync(path.join(repoRoot, "scripts"));
    mkdirSync(path.join(repoRoot, "server"));
    writeFileSync(path.join(repoRoot, "scripts", "shipped-plugins.json"), "[]");
    expect(resolveShippedPluginSource({ serverPackageRoot: path.join(repoRoot, "server") })).toEqual({
      kind: "repository",
      root: repoRoot,
      listPath: path.join(repoRoot, "scripts", "shipped-plugins.json"),
    });
  });

  it("returns null when neither exists (for example an upstream payload)", () => {
    const root = makeTempDir();
    expect(resolveShippedPluginSource({ serverPackageRoot: path.join(root, "server") })).toBeNull();
  });

  it("resolves this checkout to the repository list, whose entries exist", () => {
    const source = resolveShippedPluginSource();
    expect(source?.kind).toBe("repository");
    expect(path.dirname(SERVER_PACKAGE_ROOT)).toBe(source?.root);
    const plugins = readShippedPlugins(source!);
    expect(plugins.map((plugin) => plugin.name)).toContain(PLUGIN_NAME);
    for (const plugin of plugins) {
      const pkg = JSON.parse(readFileSync(path.join(plugin.localPath, "package.json"), "utf8"));
      expect(pkg.name).toBe(plugin.name);
      expect(pkg.paperclipPlugin).toBeTruthy();
      expect(Array.isArray(pkg.files)).toBe(true);
    }
  });
});

describe("readShippedPlugins", () => {
  function sourceWith(contents: unknown) {
    const root = makeTempDir();
    const listPath = path.join(root, "list.json");
    writeFileSync(listPath, JSON.stringify(contents));
    return { kind: "repository" as const, root, listPath };
  }

  it("resolves dirs against the source root", () => {
    const source = sourceWith([{ dir: PLUGIN_DIR, name: PLUGIN_NAME }]);
    expect(readShippedPlugins(source)).toEqual([{ dir: PLUGIN_DIR, name: PLUGIN_NAME, localPath: path.join(source.root, PLUGIN_DIR) }]);
  });

  it.each([
    [{ plugins: [] }],
    [[{ dir: "../outside", name: "x" }]],
    [[{ dir: "/abs", name: "x" }]],
    [[{ dir: "a", name: "" }]],
    [[{ dir: "a", name: "x" }, { dir: "b", name: "x" }]],
  ])("rejects an invalid list %j", (contents) => {
    expect(() => readShippedPlugins(sourceWith(contents))).toThrow();
  });

  it("logs and reconciles nothing when the list is invalid", async () => {
    const { deps } = harness([], new Map());
    await expect(reconcileShippedPlugins(sourceWith({}), deps)).resolves.toEqual([]);
    expect(deps.logger.error).toHaveBeenCalled();
    expect(deps.loader.installPlugin).not.toHaveBeenCalled();
  });
});

describe("ensureShippedPlugins", () => {
  it("installs a missing plugin and marks it ready", async () => {
    const payload = makeTempDir();
    const localPath = writePluginCopy(payload);
    const { deps, rows } = harness([], new Map([[localPath, manifest("0.1.0")]]));
    const outcomes = await ensureShippedPlugins(shipped(localPath), deps);
    expect(outcomes).toEqual([{ name: PLUGIN_NAME, pluginKey: PLUGIN_KEY, action: "installed" }]);
    expect(rows.get(PLUGIN_KEY)).toMatchObject({ packagePath: localPath, status: "ready", version: "0.1.0" });
  });

  it("rebinds to the new payload after an update and approves added capabilities", async () => {
    const oldPayload = makeTempDir();
    const newPayload = makeTempDir();
    const oldPath = writePluginCopy(oldPayload);
    const newPath = writePluginCopy(newPayload);
    const next = manifest("0.2.0", ["events.subscribe", "http.outbound"]);
    const { deps, rows } = harness(
      [adoRow({ packagePath: oldPath, status: "upgrade_pending" })],
      new Map([[newPath, next]]),
    );
    const outcomes = await ensureShippedPlugins(shipped(newPath), deps);
    expect(outcomes[0]?.action).toBe("rebound");
    expect(rows.get(PLUGIN_KEY)).toMatchObject({ id: "ado-row", packagePath: newPath, version: "0.2.0", status: "ready", manifestJson: next });
    expect(deps.loader.installPlugin).not.toHaveBeenCalled();
  });

  it("rolls back to the previous payload's copy and its older manifest", async () => {
    const previous = makeTempDir();
    const current = makeTempDir();
    const previousPath = writePluginCopy(previous);
    const currentPath = writePluginCopy(current);
    const { deps, rows } = harness(
      [adoRow({ packagePath: currentPath, version: "0.2.0", manifestJson: manifest("0.2.0") })],
      new Map([[previousPath, manifest("0.1.0")]]),
    );
    const outcomes = await ensureShippedPlugins(shipped(previousPath), deps);
    expect(outcomes[0]?.action).toBe("rebound");
    expect(rows.get(PLUGIN_KEY)).toMatchObject({ packagePath: previousPath, version: "0.1.0", status: "ready" });
  });

  it("adopts a manual install of the same plugin key instead of creating a duplicate", async () => {
    const repo = makeTempDir();
    const localPath = writePluginCopy(repo);
    const { deps, rows } = harness(
      [adoRow({ packagePath: "/app/packages/plugins/plugin-ado-manual", packageName: "plugin-ado-local" })],
      new Map([[localPath, manifest("0.1.0")]]),
    );
    const outcomes = await ensureShippedPlugins(shipped(localPath), deps);
    expect(outcomes[0]?.action).toBe("rebound");
    expect(rows.size).toBe(1);
    expect(rows.get(PLUGIN_KEY)).toMatchObject({ id: "ado-row", packagePath: localPath, packageName: PLUGIN_NAME, status: "ready" });
    expect(deps.loader.installPlugin).not.toHaveBeenCalled();
  });

  it("refreshes the stored manifest in place when the content changed at the same path", async () => {
    const repo = makeTempDir();
    const localPath = writePluginCopy(repo);
    const changed = { ...manifest("0.1.0"), description: "changed" } as PaperclipPluginManifestV1;
    const { deps, rows } = harness([adoRow({ packagePath: localPath })], new Map([[localPath, changed]]));
    const outcomes = await ensureShippedPlugins(shipped(localPath), deps);
    expect(outcomes[0]?.action).toBe("updated");
    expect(rows.get(PLUGIN_KEY)?.manifestJson).toEqual(changed);
  });

  it("writes nothing when the same copy is already bound", async () => {
    const repo = makeTempDir();
    const localPath = writePluginCopy(repo);
    const { deps } = harness([adoRow({ packagePath: localPath })], new Map([[localPath, manifest("0.1.0")]]));
    const outcomes = await ensureShippedPlugins(shipped(localPath), deps);
    expect(outcomes[0]?.action).toBe("unchanged");
    expect(deps.registry.update).not.toHaveBeenCalled();
    expect(deps.registry.updateStatus).not.toHaveBeenCalled();
    expect(deps.lifecycle.load).not.toHaveBeenCalled();
  });

  it("keeps a disabled plugin disabled but still rebinds it", async () => {
    const payload = makeTempDir();
    const localPath = writePluginCopy(payload);
    const { deps, rows } = harness([adoRow({ packagePath: "/old/payload", status: "disabled" })], new Map([[localPath, manifest("0.1.0")]]));
    await ensureShippedPlugins(shipped(localPath), deps);
    expect(rows.get(PLUGIN_KEY)).toMatchObject({ packagePath: localPath, status: "disabled" });
  });

  it("gives an errored plugin one fresh attempt per boot", async () => {
    const payload = makeTempDir();
    const localPath = writePluginCopy(payload);
    const { deps, rows } = harness([adoRow({ packagePath: localPath, status: "error", lastError: "boom" })], new Map([[localPath, manifest("0.1.0")]]));
    await ensureShippedPlugins(shipped(localPath), deps);
    expect(rows.get(PLUGIN_KEY)).toMatchObject({ status: "ready", lastError: null });
  });

  it("reactivates a soft-uninstalled row rather than adding a second one", async () => {
    const payload = makeTempDir();
    const localPath = writePluginCopy(payload);
    const { deps, rows } = harness([adoRow({ packagePath: "/old", status: "uninstalled" })], new Map([[localPath, manifest("0.1.0")]]));
    const outcomes = await ensureShippedPlugins(shipped(localPath), deps);
    expect(outcomes[0]?.action).toBe("reinstalled");
    expect(rows.size).toBe(1);
    expect(rows.get(PLUGIN_KEY)).toMatchObject({ id: "ado-row", packagePath: localPath, status: "ready" });
  });

  it("never touches plugins that are not on the list", async () => {
    const payload = makeTempDir();
    const localPath = writePluginCopy(payload);
    const other = { ...OTHER_ROW };
    const { deps, rows, calls } = harness([other], new Map([[localPath, manifest("0.1.0")]]));
    await ensureShippedPlugins(shipped(localPath), deps);
    expect(rows.get(OTHER_ROW.pluginKey)).toEqual(OTHER_ROW);
    expect(calls.filter((call) => call.includes(OTHER_ROW.pluginKey))).toEqual([]);
  });

  it("skips an unbuilt checkout without installing or building", async () => {
    const repo = makeTempDir();
    const localPath = writePluginCopy(repo, { built: false });
    const { deps } = harness([], new Map([[localPath, manifest("0.1.0")]]));
    const outcomes = await ensureShippedPlugins(shipped(localPath), deps);
    expect(outcomes[0]).toMatchObject({ action: "skipped" });
    expect(deps.loader.installPlugin).not.toHaveBeenCalled();
  });

  it("fails one plugin safely when its package name does not match the list", async () => {
    const repo = makeTempDir();
    const localPath = writePluginCopy(repo, { name: "@someone/else" });
    const { deps } = harness([], new Map([[localPath, manifest("0.1.0")]]));
    const outcomes = await ensureShippedPlugins(shipped(localPath), deps);
    expect(outcomes[0]).toMatchObject({ action: "failed" });
    expect(deps.logger.error).toHaveBeenCalled();
    expect(deps.loader.installPlugin).not.toHaveBeenCalled();
  });

  it("continues after an install error", async () => {
    const payload = makeTempDir();
    const localPath = writePluginCopy(payload);
    const { deps } = harness([], new Map([[localPath, manifest("0.1.0")]]));
    vi.mocked(deps.loader.installPlugin).mockRejectedValueOnce(new Error("migration failed"));
    const outcomes = await ensureShippedPlugins([...shipped(localPath), ...shipped(localPath)], deps);
    expect(outcomes.map((outcome) => outcome.action)).toEqual(["failed", "installed"]);
  });
});
