#!/usr/bin/env node
// Chimera fork: in-repo plugins that ship with the server.
//
// `scripts/shipped-plugins.json` is the single list of in-repo plugins that
// every deployment of this build installs and keeps updated on its own (see
// "How in-repo plugins ship" in doc/DEPLOYMENT-STEPS.md). This module is the
// only code that reads that list on the build side:
//
// - `prepare-bundled-package.mjs` calls `stageShippedPlugins` while it stages
//   `@paperclipai/server` for the managed git install, so each listed plugin is
//   built and copied into the server package (`shipped-plugins/<dir>`). The
//   copy is inside the install payload, so it follows `paperclipai update` and
//   `paperclipai update --rollback` with no extra state.
// - The Docker build runs `node scripts/shipped-plugins.mjs build`, because the
//   image runs from the repository layout (`/app/<dir>`).
//
// The server reads the same list at startup (server/src/services/shipped-plugins.ts).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SHIPPED_PLUGIN_LIST = "scripts/shipped-plugins.json";
/** Folder inside the staged server package that holds the plugin copies. */
export const SHIPPED_PLUGIN_STAGE_DIR = "shipped-plugins";
/** Copy of the list written next to the plugin copies; dirs are relative to it. */
export const SHIPPED_PLUGIN_INDEX = "shipped-plugins.json";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Kept out of the staged package.json: dependencies are bundled into the
// worker, and the scripts only make sense inside the workspace.
const STRIPPED_PACKAGE_FIELDS = ["scripts", "dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "peerDependenciesMeta", "publishConfig"];

function isContainedRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value) || value.includes("\\")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function parseShippedPluginList(raw, label = SHIPPED_PLUGIN_LIST) {
  if (!Array.isArray(raw)) throw new Error(`${label} must be a JSON array of { "dir", "name" } entries`);
  const names = new Set();
  const dirs = new Set();
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label}[${index}] must be an object`);
    const { dir, name } = entry;
    if (!isContainedRelativePath(dir)) throw new Error(`${label}[${index}].dir must be a relative path inside the repository`);
    if (typeof name !== "string" || name.trim() === "") throw new Error(`${label}[${index}].name must be the plugin's package name`);
    if (names.has(name) || dirs.has(dir)) throw new Error(`${label} lists ${name} (${dir}) twice`);
    names.add(name);
    dirs.add(dir);
    return { dir, name };
  });
}

/** Read the list; an absent file (for example an upstream checkout) means no shipped plugins. */
export function readShippedPluginList(sourceRoot = repoRoot) {
  const file = resolve(sourceRoot, SHIPPED_PLUGIN_LIST);
  if (!existsSync(file)) return [];
  return parseShippedPluginList(JSON.parse(readFileSync(file, "utf8")));
}

export function buildShippedPlugins(sourceRoot = repoRoot, { run = execFileSync, entries = readShippedPluginList(sourceRoot) } = {}) {
  for (const entry of entries) {
    run("pnpm", ["--filter", entry.name, "build"], { cwd: sourceRoot, stdio: "inherit" });
  }
  return entries;
}

function assertInside(root, candidate, label) {
  const value = relative(root, candidate);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`${label} escapes its plugin package`);
  }
}

/**
 * Copy one built plugin into `targetDir`: a trimmed package.json plus every
 * entry of the plugin's `files` field (for plugin-ado: dist/ and migrations/).
 * `files` is required so what ships is explicit, and every declared
 * `paperclipPlugin` entrypoint must be present in the copy.
 */
export function copyShippedPlugin(sourceRoot, entry, targetDir) {
  const pluginDir = resolve(sourceRoot, entry.dir);
  const pkg = JSON.parse(readFileSync(resolve(pluginDir, "package.json"), "utf8"));
  if (pkg.name !== entry.name) throw new Error(`${entry.dir}/package.json is ${pkg.name}, but ${SHIPPED_PLUGIN_LIST} lists ${entry.name}`);
  if (!pkg.paperclipPlugin || typeof pkg.paperclipPlugin !== "object") throw new Error(`${entry.name} has no paperclipPlugin entrypoints`);
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new Error(`${entry.name} must declare a "files" list in package.json (what the plugin needs at runtime, e.g. ["dist", "migrations"])`);
  }
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  for (const file of pkg.files) {
    if (!isContainedRelativePath(file.replace(/\/$/, ""))) throw new Error(`${entry.name} files entry ${JSON.stringify(file)} must be a relative path`);
    const from = resolve(pluginDir, file);
    if (!existsSync(from)) throw new Error(`${entry.name} is missing ${file}; build it first (pnpm --filter ${entry.name} build)`);
    cpSync(from, resolve(targetDir, file), { recursive: true, dereference: true });
  }
  const staged = { ...pkg };
  for (const field of STRIPPED_PACKAGE_FIELDS) delete staged[field];
  writeFileSync(resolve(targetDir, "package.json"), `${JSON.stringify(staged, null, 2)}\n`);
  for (const [key, declared] of Object.entries(pkg.paperclipPlugin)) {
    if (typeof declared !== "string") continue;
    const target = resolve(targetDir, declared);
    assertInside(targetDir, target, `${entry.name} paperclipPlugin.${key}`);
    if (!existsSync(target)) throw new Error(`${entry.name} paperclipPlugin.${key} (${declared}) is not in the staged copy; add it to "files"`);
    if (key !== "ui" && !statSync(target).isFile()) throw new Error(`${entry.name} paperclipPlugin.${key} (${declared}) is not a file`);
  }
}

/**
 * Build every listed plugin and stage a self-contained copy of each under
 * `destinationDir/<dir>`, with the list written to `destinationDir/shipped-plugins.json`.
 * Returns the staged entries; with an empty list nothing is written.
 */
export function stageShippedPlugins(sourceRoot, destinationDir, { build = true, run = execFileSync } = {}) {
  const entries = readShippedPluginList(sourceRoot);
  rmSync(destinationDir, { recursive: true, force: true });
  if (entries.length === 0) return entries;
  if (build) buildShippedPlugins(sourceRoot, { run, entries });
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of entries) copyShippedPlugin(sourceRoot, entry, resolve(destinationDir, entry.dir));
  writeFileSync(resolve(destinationDir, SHIPPED_PLUGIN_INDEX), `${JSON.stringify(entries, null, 2)}\n`);
  return entries;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, destination] = process.argv.slice(2);
  if (command === "build") {
    const entries = buildShippedPlugins(repoRoot);
    console.log(`[shipped-plugins] built ${entries.map((entry) => entry.name).join(", ") || "nothing (empty list)"}`);
  } else if (command === "stage" && destination) {
    const entries = stageShippedPlugins(repoRoot, resolve(destination));
    console.log(`[shipped-plugins] staged ${entries.length} plugin(s) into ${resolve(destination)}`);
  } else {
    console.error("Usage: shipped-plugins.mjs build | stage <destination-dir>");
    process.exit(1);
  }
}
