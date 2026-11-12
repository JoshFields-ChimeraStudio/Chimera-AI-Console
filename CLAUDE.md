# CLAUDE.md

This is **Chimera-AI-Console**, Chimera Studio's fork of [Paperclip](https://github.com/paperclipai/paperclip), the control plane we use to run the AI agent team (Tiamat and the dragons). This is a private, standalone build for Chimera Studio's own use. Remote: `origin` = `JoshFields-ChimeraStudio/Chimera-AI-Console`, branch `master`. We do not track or merge upstream Paperclip changes, so change whatever we need without worrying about merge friction.

@AGENTS.md

`AGENTS.md` is the upstream contributor guide and the single source of truth for engineering rules (repo map, company scoping, contract syncing, DB workflow, verification, definition of done). **Do not copy its content here.** This file only adds what is specific to our build, our machines and our VM.

**Overrides to `AGENTS.md`:** there is no CI for this repo, so wherever it asks for CI results, the local checks below are the gate. Its rule against committing `pnpm-lock.yaml` does not apply (see the lockfile note at the end).

## Where the other docs are

- `doc/BACKLOG.md`: planned changes to this build (ADO integration, run logging and debugging UI, agent memory). The only backlog; update it in place.
- `doc/LOCAL-DOCKER.md`: our step-by-step guide to running a local instance in Docker on Windows.
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

Current VM (details in `../PAPERCLIP-PILOT.md`): `vm-paperclip-westus-001`, subscription `sb_sbxquetz_joshf`, reached only over the studio VPN (SSH from the VPN range, HTTPS via Caddy on 443 in front of Paperclip on loopback 3100). Paperclip runs as a **systemd user service** (`paperclipai service ...`) under the `paperclip` user, instance data in `~/.paperclip/instances/default`.

**Important:** the VM was set up with the *upstream npm release* (`npx paperclipai install`), not this fork. Nothing from this fork is running there yet.

The supported route for deploying the fork is the managed git-ref install (`doc/INSTALLING.md`). It resolves the ref to an exact commit, builds it on the VM, and keeps the last two payloads for rollback. Instance data is untouched.

```sh
# On the VM, as the paperclip user. If the fork repo is private, export GH_TOKEN or GITHUB_TOKEN
# (read access to the repo) first; the installer uses it to resolve the ref.
paperclipai service status
paperclipai install --repo JoshFields-ChimeraStudio/Chimera-AI-Console --ref master
paperclipai service restart

# later updates (re-resolves the branch, backs up the DB, switches payload, restarts the service)
paperclipai update
paperclipai update --check      # exit code 10 = update available
paperclipai update --rollback   # back to the previous payload
paperclipai doctor
```

Notes and risks:

- A branch ref follows the branch on `update`; a commit SHA or tag is pinned. For anything but testing, deploy a tag or SHA.
- A git install runs `pnpm install --frozen-lockfile` and the full build on the VM. The build includes the Rust Runner, so the VM may need a Rust toolchain and more than the pilot VM's 2 vCPU / 8 GB. **Unverified; try it and record the result here.**
- The first switch from the npm install to a git install has not been tried. Take a manual DB backup first (`paperclipai db:backup`; automatic backups land in `~/.paperclip/instances/default/data/backups`), and check `paperclipai --version` and `/api/health` afterwards.
- Never `npm`-update or reinstall while agents are mid-run; use the guarded restart in `doc/DEVELOPING.md` (Hot-Restart Deploys).
- Telemetry is opt-out and goes to Paperclip's endpoint. On the VM it is disabled in the instance `config.json` (`telemetry.enabled = false`). Re-check after any install.
- Alternative path if the git install fails: build the Docker image (`Dockerfile`) and run it on the VM. That would replace the service-based setup, so decide deliberately.

## Working rules for this build

- **Lockfile: keep `pnpm-lock.yaml` and commit it with any dependency change** (run `pnpm install`, then commit the result). The Docker build copies it, and the VM's git install runs `pnpm install --frozen-lockfile`, which fails if it is missing or stale. Deleting it would also let every build resolve different dependency versions, which can break the pinned patches in `patches/` and the overrides in `pnpm-workspace.yaml`.
- **Line endings must be LF in the working tree.** The Windows checkout currently has CRLF (git reports ~256 phantom modified files), which breaks the Docker build. Fix once with the steps in `doc/LOCAL-DOCKER.md` (`git config core.autocrlf input` and re-checkout). Don't commit line-ending-only changes.
- Never read or stage `.env`, `docker/.env`, `config.json`, `secrets/` or `master.key`. Ask for specific values instead.
- Agents work on `ai/<work-item-id>-<short-name>` branches and open PRs into `master`; they never commit to `master` directly.
