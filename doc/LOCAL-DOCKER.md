# Local Docker setup (Windows)

How to build and run a local instance of Chimera-AI-Console in Docker, for testing changes before they go to the Azure VM.

> **Status: written from the repo's `Dockerfile`, compose files and docs. Not yet run end to end.** Expect to adjust something on the first pass and fix this file when you do.

This complements `doc/DOCKER.md` (the upstream reference). It covers only the path we use: Docker Desktop on Windows, the full stack compose file, PowerShell commands, run from `D:\projects\AI Team\Chimera-AI-Console`.

## What you get

Two containers from `docker/docker-compose.yml`:

| Service | What | Data |
|---|---|---|
| `server` | Paperclip (API plus UI) built from this checkout, on `http://localhost:3100`, login required | named volume `paperclip-data` |
| `db` | PostgreSQL 17 | named volume `pgdata` |

The image includes the Claude Code, Codex and other agent CLIs, `git`, `gh` and Python. It does **not** include the .NET SDK, so agents running inside this container cannot build our C# projects. Use this instance to test the console, server and UI changes. Agent work stays on the VM.

Named volumes (not folders on `D:`) are used on purpose: PostgreSQL data on a Windows bind mount is the usual source of permission and speed problems. The simpler `docker-compose.quickstart.yml` (embedded database, bind mount at `data/docker-paperclip`) also exists; switch to it only if you want to match the VM's embedded database and accept that risk.

## 1. Prerequisites

1. **Docker Desktop** with the WSL 2 backend (Settings > General > "Use the WSL 2 based engine").
2. **Memory and disk for the build.** The first build compiles a Rust daemon and the whole TypeScript monorepo, and the Dockerfile lets Node use up to 4 GB. My estimate: give Docker **at least 8 GB RAM** and keep **15 GB or more** of disk free. The build will be slow the first time (likely tens of minutes) and fast after that because layers are cached.
   To set memory for the WSL 2 backend, create or edit `%UserProfile%\.wslconfig`:
   ```ini
   [wsl2]
   memory=10GB
   ```
   then run `wsl --shutdown` and restart Docker Desktop.
3. **Git for Windows** (you already have this).

## 2. Fix line endings (one time, required)

Your checkout has Windows (CRLF) line endings, but the repository stores LF. The image build copies those files into Linux. A CRLF `scripts/docker-entrypoint.sh` makes the container fail on start with `exec ... no such file or directory`, and the build's generated-file checks can fail as well.

In PowerShell:

```powershell
cd "D:\projects\AI Team\Chimera-AI-Console"

# Safety check: this must print nothing. If it lists files, you have real edits. Commit or stash them first.
git diff --ignore-cr-at-eol --stat

git config core.autocrlf input
git rm -r --cached . -q
git reset --hard -q

# Verify: both lines should show w/lf
git ls-files --eol Dockerfile scripts/docker-entrypoint.sh
```

Untracked files such as `CLAUDE.md` are left alone. This also clears the ~256 phantom "modified" files in `git status`.

## 3. Create the secrets file (one time)

Compose refuses to start without `BETTER_AUTH_SECRET`. Create `docker/.env` with two independent random secrets. `docker/.env` is already ignored by git (`.gitignore` line 15).

```powershell
cd "D:\projects\AI Team\Chimera-AI-Console"

function New-Secret {
  $b = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

$path = Join-Path (Get-Location) "docker\.env"
if (Test-Path $path) { throw "docker\.env already exists. Keep its existing secrets." }

$text = "BETTER_AUTH_SECRET=$(New-Secret)`nPAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(New-Secret)`n"
[System.IO.File]::WriteAllText($path, $text)   # UTF-8 without BOM; a BOM would break the first variable name
```

Keep these values for the life of the instance. Changing them signs everyone out and invalidates pending approvals. Back the file up somewhere private (it is a secret; never commit or paste it).

## 4. Build and start

```powershell
docker compose -f docker/docker-compose.yml up --build -d
docker compose -f docker/docker-compose.yml logs -f server     # Ctrl+C stops following, not the server
```

When the logs settle, check health:

```powershell
curl.exe http://localhost:3100/api/health
```

Use `curl.exe`; plain `curl` in Windows PowerShell 5.1 is an alias for a different command. Expect `{"status":"ok"}`.

## 5. First sign-in

1. Open `http://localhost:3100`.
2. Sign up with an email and password.
3. On the setup screen choose **Claim this instance**. You become the admin.

## 6. Connect Claude

In the UI go to **Apps > Connections** and sign in to Claude with your subscription in the browser, or paste an API key. This container has its own sign-in; it does not share the VM's.

Be deliberate about API keys: an API key bills per token, a subscription sign-in does not. The compose file does not pass `ANTHROPIC_API_KEY` into the container, so nothing is billed unless you add a key here.

## 7. Day to day

```powershell
# After pulling or editing code: rebuild and restart (only changed layers rebuild)
docker compose -f docker/docker-compose.yml up --build -d

docker compose -f docker/docker-compose.yml ps          # status
docker compose -f docker/docker-compose.yml logs -f server
docker compose -f docker/docker-compose.yml stop        # stop, keep everything
docker compose -f docker/docker-compose.yml start
docker compose -f docker/docker-compose.yml down        # remove containers, KEEP data volumes
docker compose -f docker/docker-compose.yml down -v     # DELETES the database and instance data. Fresh start only.
```

For fast UI/server iteration without rebuilding the image each time, `pnpm dev` (see `CLAUDE.md`) is quicker; use Docker for "does the real image build and run".

Optional hardening and tweaks, by editing `docker/docker-compose.yml`:

- The `db` service publishes PostgreSQL on host port 5432 with the password `paperclip`. Change `"5432:5432"` to `"127.0.0.1:5432:5432"` so only your machine can reach it, or remove the line.
- Turn off Paperclip's telemetry (it is opt-out and sends to Paperclip's endpoint): add `PAPERCLIP_TELEMETRY_DISABLED: "1"` under `server` > `environment`.
- The host port is fixed at `3100`. If it is taken, change the left side of `"3100:3100"` and set `PAPERCLIP_PUBLIC_URL` in `docker/.env` to the new URL, or sign-in redirects will break.

## 8. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Server container restarts with `exec ... docker-entrypoint.sh: no such file or directory` | CRLF line endings. Redo step 2, then rebuild with `up --build -d`. |
| Build stops with a generated-file or "drift" check error | Same cause (CRLF). Redo step 2. |
| Build is killed, "exit code 137", or Docker Desktop freezes | Out of memory. Raise memory in `.wslconfig` (step 1), `wsl --shutdown`, retry. |
| `BETTER_AUTH_SECRET must be set` | `docker/.env` missing, in the wrong folder, or saved with a BOM. Recreate it with step 3. |
| `curl.exe` health check fails, page won't load | `docker compose ... ps` and `logs server`. The server waits for the database health check first. |
| Sign-in loops or redirects to the wrong address | `PAPERCLIP_PUBLIC_URL` doesn't match the URL in your browser. |
| Onboarding fails with `ACPX provider package ... resolves outside the selected provider root` | Upstream's pnpm-workspace Docker layout trips the ACPX install check. This fork patches `packages/paperclip-runner/src/drivers/acpx/installation-integrity.ts` to accept the workspace's pnpm store. If it returns, check that patch is still there. |
| Onboarding fails with `Paperclip Runner is unavailable for this harness and environment` right after a rebuild | The server detects libc once at startup and caches it. A slow boot can make that fail. Run `docker compose -f docker/docker-compose.yml restart server`. The timeout is now 5 s, so this should be rare. |
| Installing a plugin from `packages/plugins/` fails with `Cannot find package '@paperclipai/plugin-sdk'` | The image installs dependencies only for packages whose `package.json` is copied in the `deps` stage of the `Dockerfile`. Add a `COPY packages/plugins/<name>/package.json packages/plugins/<name>/` line next to the others, then rebuild with `up --build -d`. |
| Disk fills up | `docker builder prune` clears build cache; `docker image prune` removes old images. Neither touches data volumes. |

## 9. Remove everything

```powershell
docker compose -f docker/docker-compose.yml down -v
docker image rm $(docker images -q "docker-server")   # optional
```

Then delete `docker\.env` if you won't use the instance again.
