import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SHIPPED_PLUGIN_INDEX,
  copyShippedPlugin,
  parseShippedPluginList,
  readShippedPluginList,
  stageShippedPlugins,
} from "../shipped-plugins.mjs";

const withScratch = async (body) => {
  const root = mkdtempSync(join(tmpdir(), "shipped-plugins-"));
  try { await body(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const ENTRY = { dir: "packages/plugins/plugin-ado", name: "@chimera/plugin-ado" };

function writeFixturePlugin(root, overrides = {}) {
  const dir = join(root, ENTRY.dir);
  mkdirSync(join(dir, "dist", "ui"), { recursive: true });
  mkdirSync(join(dir, "migrations"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "dist", "manifest.js"), "export default {};\n");
  writeFileSync(join(dir, "dist", "worker.js"), "export {};\n");
  writeFileSync(join(dir, "dist", "ui", "index.js"), "export {};\n");
  writeFileSync(join(dir, "migrations", "001_init.sql"), "select 1;\n");
  writeFileSync(join(dir, "src", "worker.ts"), "source\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: ENTRY.name,
    version: "0.1.0",
    type: "module",
    files: ["dist", "migrations"],
    scripts: { build: "node build.mjs" },
    dependencies: { "@paperclipai/plugin-sdk": "workspace:*" },
    devDependencies: { esbuild: "^0.28.2" },
    paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js", ui: "./dist/ui/" },
    ...overrides,
  }));
  return dir;
}

test("the repository list parses and names plugin-ado", () => {
  const entries = readShippedPluginList();
  assert.ok(entries.some((entry) => entry.name === "@chimera/plugin-ado" && entry.dir === "packages/plugins/plugin-ado"));
});

test("an absent list means no shipped plugins", async () => {
  await withScratch(async (root) => {
    assert.deepEqual(readShippedPluginList(root), []);
  });
});

test("the list rejects bad shapes, escaping dirs and duplicates", () => {
  assert.throws(() => parseShippedPluginList({ plugins: [] }));
  assert.throws(() => parseShippedPluginList([{ dir: "../x", name: "x" }]));
  assert.throws(() => parseShippedPluginList([{ dir: "/x", name: "x" }]));
  assert.throws(() => parseShippedPluginList([{ dir: "x", name: "" }]));
  assert.throws(() => parseShippedPluginList([{ dir: "x", name: "a" }, { dir: "y", name: "a" }]));
  assert.throws(() => parseShippedPluginList([{ dir: "x", name: "a" }, { dir: "x", name: "b" }]));
  assert.deepEqual(parseShippedPluginList([ENTRY]), [ENTRY]);
});

test("a staged copy holds package.json and the files entries only, with workspace fields stripped", async () => {
  await withScratch(async (root) => {
    writeFixturePlugin(root);
    const target = join(root, "out", ENTRY.dir);
    copyShippedPlugin(root, ENTRY, target);
    assert.ok(existsSync(join(target, "dist", "worker.js")));
    assert.ok(existsSync(join(target, "dist", "ui", "index.js")));
    assert.ok(existsSync(join(target, "migrations", "001_init.sql")));
    assert.equal(existsSync(join(target, "src")), false);
    assert.equal(existsSync(join(target, "node_modules")), false);
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    assert.equal(pkg.name, ENTRY.name);
    assert.equal(pkg.type, "module");
    assert.deepEqual(pkg.paperclipPlugin, { manifest: "./dist/manifest.js", worker: "./dist/worker.js", ui: "./dist/ui/" });
    for (const field of ["scripts", "dependencies", "devDependencies"]) assert.equal(pkg[field], undefined);
  });
});

test("a plugin without a files list, an unbuilt plugin, or a wrong name is refused", async () => {
  await withScratch(async (root) => {
    writeFixturePlugin(root, { files: undefined });
    assert.throws(() => copyShippedPlugin(root, ENTRY, join(root, "out")), /"files"/);
  });
  await withScratch(async (root) => {
    const dir = writeFixturePlugin(root);
    rmSync(join(dir, "dist"), { recursive: true });
    assert.throws(() => copyShippedPlugin(root, ENTRY, join(root, "out")), /build it first/);
  });
  await withScratch(async (root) => {
    writeFixturePlugin(root, { files: ["migrations"] });
    assert.throws(() => copyShippedPlugin(root, ENTRY, join(root, "out")), /not in the staged copy/);
  });
  await withScratch(async (root) => {
    writeFixturePlugin(root, { name: "@other/plugin" });
    assert.throws(() => copyShippedPlugin(root, ENTRY, join(root, "out")), /lists @chimera\/plugin-ado/);
  });
});

test("staging builds each listed plugin, copies it and writes the list beside the copies", async () => {
  await withScratch(async (root) => {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "shipped-plugins.json"), JSON.stringify([ENTRY]));
    writeFixturePlugin(root);
    const commands = [];
    const destination = join(root, "server-stage", "shipped-plugins");
    const entries = stageShippedPlugins(root, destination, { run: (file, args, options) => commands.push([file, args, options.cwd]) });
    assert.deepEqual(entries, [ENTRY]);
    assert.deepEqual(commands, [["pnpm", ["--filter", ENTRY.name, "build"], root]]);
    assert.ok(existsSync(join(destination, ENTRY.dir, "dist", "worker.js")));
    assert.deepEqual(JSON.parse(readFileSync(join(destination, SHIPPED_PLUGIN_INDEX), "utf8")), [ENTRY]);
  });
});

test("staging with no list writes nothing and builds nothing", async () => {
  await withScratch(async (root) => {
    const destination = join(root, "shipped-plugins");
    mkdirSync(destination);
    const commands = [];
    assert.deepEqual(stageShippedPlugins(root, destination, { run: (...args) => commands.push(args) }), []);
    assert.equal(existsSync(destination), false);
    assert.deepEqual(commands, []);
  });
});
