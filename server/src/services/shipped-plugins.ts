import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

/**
 * Chimera fork: in-repo plugins that ship with the server.
 *
 * `scripts/shipped-plugins.json` lists the in-repo plugins every deployment of
 * this build runs. They are trusted like the server code itself: at startup
 * this module installs each listed plugin that is missing, and rebinds an
 * existing install of the same plugin key (including one an operator made by
 * hand) to the copy that ships with the running server, refreshing its stored
 * manifest and approving its declared capabilities without an
 * `upgrade_pending` stop. Plugins that are not on the list are never touched.
 *
 * Where the copy lives:
 * - Managed git install (`paperclipai install --ref` / `update`): the build
 *   step (`scripts/prepare-bundled-package.mjs` → `scripts/shipped-plugins.mjs`)
 *   puts a built copy of each listed plugin inside the server package, under
 *   `shipped-plugins/<dir>`, with the list beside it. The copy is part of the
 *   payload, so an update or a rollback switches plugin code with the server.
 * - Docker image and dev runs: the repository is on disk (`/app` in Docker),
 *   so the plugin is used in place at `<repo>/<dir>`; the Docker build runs
 *   `node scripts/shipped-plugins.mjs build`.
 *
 * This runs once per boot, before `loader.loadAll()`, so no worker is running
 * yet: `loadAll()` starts each plugin's worker from the rebound path, applies
 * its new migrations and re-reads its manifest. Fail-safe per plugin, like
 * `ensureBundledPlugins`: errors are logged and boot continues.
 */

export const SHIPPED_PLUGIN_LIST = "scripts/shipped-plugins.json";
export const SHIPPED_PLUGIN_STAGE_DIR = "shipped-plugins";
export const SHIPPED_PLUGIN_INDEX = "shipped-plugins.json";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/**
 * Root of the `@paperclipai/server` package: `server/` in the repository and
 * the Docker image, `<payload>/node_modules/@paperclipai/server` in a managed
 * install. Valid from both `src/services` and `dist/services`.
 */
export const SERVER_PACKAGE_ROOT = path.resolve(moduleDir, "../..");

export interface ShippedPluginSource {
  /** `payload`: copies inside the server package. `repository`: plugins used in place. */
  kind: "payload" | "repository";
  /** Directory the list's `dir` entries are relative to. */
  root: string;
  listPath: string;
}

export interface ShippedPlugin {
  name: string;
  dir: string;
  /** Absolute plugin package root to install from or bind to. */
  localPath: string;
}

export function resolveShippedPluginSource(
  opts: { serverPackageRoot?: string; repoRoot?: string } = {},
): ShippedPluginSource | null {
  const serverPackageRoot = path.resolve(opts.serverPackageRoot ?? SERVER_PACKAGE_ROOT);
  const stagedRoot = path.join(serverPackageRoot, SHIPPED_PLUGIN_STAGE_DIR);
  const stagedList = path.join(stagedRoot, SHIPPED_PLUGIN_INDEX);
  if (fs.existsSync(stagedList)) return { kind: "payload", root: stagedRoot, listPath: stagedList };
  const repoRoot = path.resolve(opts.repoRoot ?? path.dirname(serverPackageRoot));
  const repoList = path.join(repoRoot, SHIPPED_PLUGIN_LIST);
  if (fs.existsSync(repoList)) return { kind: "repository", root: repoRoot, listPath: repoList };
  return null;
}

function isContainedRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value) || value.includes("\\")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** Same rules as `parseShippedPluginList` in scripts/shipped-plugins.mjs. */
export function readShippedPlugins(source: ShippedPluginSource): ShippedPlugin[] {
  const raw = JSON.parse(fs.readFileSync(source.listPath, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${source.listPath} must be a JSON array of { "dir", "name" } entries`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const { dir, name } = (entry ?? {}) as { dir?: unknown; name?: unknown };
    if (!isContainedRelativePath(dir)) throw new Error(`${source.listPath}[${index}].dir must be a relative path`);
    if (typeof name !== "string" || name.trim() === "") throw new Error(`${source.listPath}[${index}].name must be a package name`);
    if (seen.has(name) || seen.has(`dir:${dir}`)) throw new Error(`${source.listPath} lists ${name} (${dir}) twice`);
    seen.add(name);
    seen.add(`dir:${dir}`);
    return { name, dir, localPath: path.resolve(source.root, dir) };
  });
}

interface ShippedRegistryRow {
  id: string;
  pluginKey: string;
  packageName: string;
  packagePath?: string | null;
  status: string;
  version: string;
  manifestJson: PaperclipPluginManifestV1;
}

export interface ShippedPluginReconcileDeps {
  registry: {
    getByKey(pluginKey: string): Promise<ShippedRegistryRow | null>;
    update(
      id: string,
      data: { packageName?: string; packagePath?: string; version?: string; manifest?: PaperclipPluginManifestV1 },
    ): Promise<unknown>;
    updateStatus(id: string, input: { status: "ready"; lastError: string | null }): Promise<unknown>;
  };
  loader: {
    loadManifest(packagePath: string): Promise<PaperclipPluginManifestV1 | null>;
    installPlugin(options: { localPath: string }): Promise<{ manifest: { id: string } | null }>;
  };
  lifecycle: { load(pluginId: string): Promise<unknown> };
  logger: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
  };
}

export type ShippedPluginAction =
  | "installed"
  | "reinstalled"
  | "rebound"
  | "updated"
  | "unchanged"
  | "skipped"
  | "failed";

export interface ShippedPluginOutcome {
  name: string;
  pluginKey?: string;
  action: ShippedPluginAction;
  reason?: string;
}

function readPackageName(localPath: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(localPath, "package.json"), "utf8")) as { name?: unknown };
    return typeof pkg.name === "string" ? pkg.name : null;
  } catch {
    return null;
  }
}

async function reconcileOne(plugin: ShippedPlugin, deps: ShippedPluginReconcileDeps): Promise<ShippedPluginOutcome> {
  const packageName = readPackageName(plugin.localPath);
  if (packageName === null) {
    return { name: plugin.name, action: "skipped", reason: `no package.json at ${plugin.localPath}` };
  }
  if (packageName !== plugin.name) {
    throw new Error(`${plugin.localPath}/package.json is ${packageName}, but the shipped plugin list names ${plugin.name}`);
  }
  const manifest = await deps.loader.loadManifest(plugin.localPath);
  if (!manifest) {
    // Dev checkout without a build: nothing to install yet. Never auto-build here.
    return { name: plugin.name, action: "skipped", reason: `not built (run pnpm --filter ${plugin.name} build)` };
  }
  const pluginKey = manifest.id;
  const existing = await deps.registry.getByKey(pluginKey);

  if (!existing || existing.status === "uninstalled") {
    // A shipped plugin is part of the build: a soft-uninstalled row is
    // reactivated (same row, so plugin data and references stay stable).
    // Disable it instead to keep it switched off.
    const discovered = await deps.loader.installPlugin({ localPath: plugin.localPath });
    const installed = await deps.registry.getByKey(discovered.manifest?.id ?? pluginKey);
    if (!installed) throw new Error(`shipped plugin ${pluginKey} installed but not found in the registry`);
    await deps.lifecycle.load(installed.id);
    return { name: plugin.name, pluginKey, action: existing ? "reinstalled" : "installed" };
  }

  const changes: { packageName?: string; packagePath?: string; version?: string; manifest?: PaperclipPluginManifestV1 } = {};
  const rebind = !existing.packagePath || path.resolve(existing.packagePath) !== plugin.localPath;
  if (rebind) changes.packagePath = plugin.localPath;
  if (existing.packageName !== packageName) changes.packageName = packageName;
  const manifestChanged = existing.version !== manifest.version || !isDeepStrictEqual(existing.manifestJson, manifest);
  if (manifestChanged) {
    // Shipped plugins are trusted like the server code: the new manifest,
    // including any added capabilities, is approved in the same write.
    changes.version = manifest.version;
    changes.manifest = manifest;
  }
  if (Object.keys(changes).length > 0) await deps.registry.update(existing.id, changes);

  if (existing.status === "upgrade_pending" || existing.status === "error") {
    // upgrade_pending: approve. error: one fresh activation attempt per boot,
    // as ensureBundledPlugins does; loadAll() starts the worker.
    await deps.registry.updateStatus(existing.id, { status: "ready", lastError: null });
  } else if (existing.status === "installed") {
    await deps.lifecycle.load(existing.id);
  }
  // `ready` is started by loadAll(); `disabled` is an operator choice and stays off.

  return {
    name: plugin.name,
    pluginKey,
    action: rebind ? "rebound" : manifestChanged || changes.packageName ? "updated" : "unchanged",
  };
}

export async function ensureShippedPlugins(
  plugins: readonly ShippedPlugin[],
  deps: ShippedPluginReconcileDeps,
): Promise<ShippedPluginOutcome[]> {
  const outcomes: ShippedPluginOutcome[] = [];
  for (const plugin of plugins) {
    try {
      const outcome = await reconcileOne(plugin, deps);
      outcomes.push(outcome);
      deps.logger.info(
        { pluginName: plugin.name, pluginKey: outcome.pluginKey, pluginPath: plugin.localPath, action: outcome.action, reason: outcome.reason },
        `shipped plugin ${outcome.action}`,
      );
    } catch (err) {
      outcomes.push({ name: plugin.name, action: "failed", reason: err instanceof Error ? err.message : String(err) });
      deps.logger.error(
        { err, pluginName: plugin.name, pluginPath: plugin.localPath },
        "Failed to reconcile shipped plugin; continuing boot (plugin unavailable)",
      );
    }
  }
  return outcomes;
}

/** Resolve and reconcile in one step; fail-safe (a bad list only logs). */
export async function reconcileShippedPlugins(
  source: ShippedPluginSource | null,
  deps: ShippedPluginReconcileDeps,
): Promise<ShippedPluginOutcome[]> {
  if (!source) return [];
  let plugins: ShippedPlugin[];
  try {
    plugins = readShippedPlugins(source);
  } catch (err) {
    deps.logger.error({ err, listPath: source.listPath }, "Failed to read the shipped plugin list; no shipped plugins reconciled");
    return [];
  }
  return ensureShippedPlugins(plugins, deps);
}
