# CLAUDE.md

This is **Chimera-AI-Console**, Chimera Studio's fork of [Paperclip](https://github.com/paperclipai/paperclip), the control plane we use to run the AI agent team (Tiamat and the dragons). This is a private, standalone build for Chimera Studio's own use. Remote: `origin` = `JoshFields-ChimeraStudio/Chimera-AI-Console`, branch `master`. We do not track or merge upstream Paperclip changes, so change whatever we need without worrying about merge friction.

@AGENTS.md

`AGENTS.md` is the upstream contributor guide and the single source of truth for engineering rules (repo map, company scoping, contract syncing, DB workflow, verification, definition of done). **Do not copy its content here.** This file only adds what is specific to our build, our machines and our VM.

**Overrides to `AGENTS.md`:** there is no CI for this repo, so wherever it asks for CI results, the local checks below are the gate. Its rule against committing `pnpm-lock.yaml` does not apply (see the lockfile note at the end).

## Where the other docs are

- `doc/BACKLOG.md`: planned changes to this build (ADO integration, run logging and debugging UI, agent memory). The only backlog; update it in place.
- `doc/LOCAL-DOCKER.md`: our step-by-step guide to running a local instance in Docker on Windows.
- `doc/DEPLOYMENT-STEPS.md`: step-by-step deploy of this fork to the Azure VM, with rollback and troubleshooting.
- `../PAPERCLIP-PILOT.md` (parent folder, `D:\projects\AI Team`): how the pilot VM was built, agent roster, decisions, troubleshooting. Read it before touching anything on the VM.
- `doc/DEVELOPING.md` (5k lines, use the headings: Start Dev, Test Commands, Hot-Restart Deploys, Local Instance Layout), `doc/INSTALLING.md`, `doc/DOCKER.md`, `doc/DEPLOYMENT-MODES.md`, `doc/DATABASE.md`.
- `rules/*.mdc`: scoped rules that `AGENTS.md` requires you to read before editing matching files.

## Architecture in one minute

pnpm monorepo (Node 24, pnpm 9.15.4, TypeScript, ESM). Express API (`server/`) serves the React/Vite board UI (`ui/`) on one port, 3100. Data lives in Postgres through Drizzle (`packages/db/`); with `DATABASE_URL` unset it uses embedded Postgres, so no database setup is needed. Agents run through adapters (`packages/adapters/*`) and the native Runner (`packages/paperclip-runner/`, TypeScript plus a **Rust** daemon, toolchain pinned to 1.97.1 in `rust-toolchain.toml`). The `paperclipai` CLI (`cli/`) is what installs, runs and services an instance. Full repo map: `AGENTS.md` section 3.

Instance state is never in the repo. It lives in `~/.paperclip/instances/<id>/` (`config.json`, `.env`, `db/`, `data/backups/`, `secrets/master.key`, `workspaces/`, `logs/`). Override with `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID`.

## Build and run locally (for testing changes)

Prerequisites: Node >= 24.11 (`.nvmrc` says 24), pnpm 9.15.4 (`corepack enable`). The docs target macOS, Linux and WSL2; **native Windows for the full dev loop is not documented, so use WSL2 or Docker** (not yet verified on our machines).

```sh
pnpm install
pnpm dev                      # API + UI at http://localhost:3100, watch mode
pnpm dev:once                 # same, no file watching, auto-applies pending migrations
pnpm dev --data-dir ./tmp/pc  # isolated state, so you never touch another instance's data
pnpm dev:list / pnpm dev:stop # inspect / stop the dev runner (add the same --data-dir)

curl http://localhost:3100/api/health
rm -rf data/pglite && pnpm dev   # reset the dev DB per AGENTS.md; the embedded DB itself lives under ~/.paperclip/instances/<id>/db (or your --data-dir)
```

`pnpm dev` defaults to `local_trusted` (no login, loopback only). To test the login-required mode the VM uses, run `pnpm dev --bind lan`.

Verify (from `AGENTS.md` section 7):

```sh
pnpm verify                   # affected Vitest files only; exit 2 means "needs broader checks", not failure
pnpm -r typecheck             # or: node scripts/typecheck-low-memory.mjs
pnpm build                    # needs the Rust toolchain for the Runner binary
pnpm check:token-gates        # required for any ui/ change (design tokens only)
node scripts/agent-preflight.mjs   # prepares a fresh worktree (install + Runner build, cached)
```

DB schema change: edit `packages/db/src/schema/*.ts`, export from `schema/index.ts`, run `pnpm db:generate`, then `pnpm -r typecheck`.

### Local Docker (closest to a real deployment)

Follow `doc/LOCAL-DOCKER.md`. The line-ending fix in step 2 of that guide is required before the image will build from this Windows checkout.

## Deploy to the Azure VM

**Follow `doc/DEPLOYMENT-STEPS.md`.** It has the full procedure: push, read-only GitHub token, VM checks (Node, Rust, swap, outbound access), backup, `install --repo ... --ref <sha>`, verification, rollback, later updates, and troubleshooting.

Key facts to keep in mind:

- VM: `vm-paperclip-westus-001`, subscription `sb_sbxquetz_joshf`, VPN-only (details in `../PAPERCLIP-PILOT.md`). Paperclip runs as a systemd user service behind Caddy (HTTPS on 443, Paperclip on loopback 3100). Instance data is in `~/.paperclip/instances/default`.
- The VM was set up with the **upstream npm release**. The fork is deployed with the managed git-ref install, which builds from GitHub, so only **pushed** commits can be deployed. The first deploy is untested; record the result in section 11 of `doc/DEPLOYMENT-STEPS.md`.
- Deploy a commit SHA the first time, take `paperclipai db:backup` first, and roll back with `paperclipai update --rollback` (the database is not rolled back).
- Telemetry is disabled in the instance `config.json` (`telemetry.enabled = false`). Re-check after any install.
- Fallback if the git install cannot work on the VM: build the Docker image (`Dockerfile`) and run it there. That replaces the service-based setup, so decide deliberately.

## Working rules for this build

- **Lockfile: keep `pnpm-lock.yaml` and commit it with any dependency change** (run `pnpm install`, then commit the result). The Docker build copies it, and the VM's git install runs `pnpm install --frozen-lockfile`, which fails if it is missing or stale. Deleting it would also let every build resolve different dependency versions, which can break the pinned patches in `patches/` and the overrides in `pnpm-workspace.yaml`.
- **Line endings must be LF in the working tree.** A CRLF Windows checkout breaks the Docker build. The fix (`git config core.autocrlf input` and re-checkout) is in `doc/LOCAL-DOCKER.md` and is already applied on Josh's machine. Don't commit line-ending-only changes.
- **Fork patches to upstream code, keep them when editing nearby:** (1) `packages/paperclip-runner/src/drivers/acpx/installation-integrity.ts` accepts the workspace pnpm store (`<root>/../node_modules/.pnpm`) as part of the provider root, because the Docker and git-install layout is a pnpm workspace; without it onboarding a Claude agent fails with "resolves outside the selected provider root". (2) `server/src/lib/agent-runner-platform.ts` waits 5 s (was 1 s) for libc detection, so a slow boot doesn't disable the native Runner. (3) `scripts/prepare-bundled-package.mjs` builds `server/ui-dist` and falls back to the repo-level `skills/` folder when the server package lacks them, because the managed git install calls that script directly and skips the server's `prepack` hook and upstream's release copy step; it also strips `prepack`/`postpack` from the staged manifest, because `npm pack` runs them outside the workspace and fails. Without these changes `paperclipai install --ref` fails with `ENOENT ... server/ui-dist` or `server/skills`, or in `npm pack`.
- Never read or stage `.env`, `docker/.env`, `config.json`, `secrets/` or `master.key`. Ask for specific values instead.
- Agents work on `ai/<work-item-id>-<short-name>` branches and open PRs into `master`; they never commit to `master` directly.
