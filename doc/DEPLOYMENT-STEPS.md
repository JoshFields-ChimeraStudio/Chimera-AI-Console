# Deployment steps: Chimera AI Console to the Azure VM

How to put this fork on `vm-paperclip-westus-001`, check it, and back out if it goes wrong. Written 2026-11-13 from the code in this repo and `../PAPERCLIP-PILOT.md`. **The VM has not been switched to the fork yet, so every step below is untested on the VM.** Record what actually happened in section 11.

## 0. What this does

The VM currently runs the **upstream npm release** of Paperclip. A git-ref install replaces the program files with a build of this fork, taken from GitHub:

- The installer asks GitHub for the exact commit, downloads that commit as a tarball, runs `pnpm install --frozen-lockfile`, builds everything (including the Rust Runner), and activates it.
- The program files and your data are separate. Instance data (database, config, secrets, uploads, workspaces) stays in `~/.paperclip/instances/default/` and is not touched.
- Previous program versions are kept (two of them), so you can roll back the program. **Database changes are not undone by a rollback.**
- Caddy, the systemd service unit, the VPN and the NAT gateway are not changed.

The VM builds what is **on GitHub**, not what is on your PC. Anything not pushed is not deployed.

## 1. Before you start

- [ ] The change you want is committed **and pushed** to `origin/master` on `JoshFields-ChimeraStudio/Chimera-AI-Console`.
- [ ] It has run in your local Docker instance (agent onboarding works, Dashboard loads).
- [ ] You are on the studio VPN and can SSH to the VM (`../PAPERCLIP-PILOT.md`, section 1.7).
- [ ] No agent is mid-run. In the Paperclip UI, check that nothing is running; pause heartbeats if needed. A restart interrupts running work.
- [ ] You have 30 to 60 minutes. The first build on a 2 vCPU VM is slow.

## 2. On your PC

**2.1 Change the build marker** so you can tell the fork from the old release. In `ui/src/pages/Dashboard.tsx`, set `CHIMERA_BUILD_MARKER` to something new, for example `"vm-1"`.

**2.2 Commit and push.**

```powershell
cd "D:\projects\AI Team\Chimera-AI-Console"
git status                      # should list only what you expect
git add -A
git commit -m "Build marker vm-1"
git push origin master
```

**2.3 Get the exact commit to deploy** and keep it for step 5:

```powershell
git rev-parse HEAD              # 40-character SHA
```

Open `https://github.com/JoshFields-ChimeraStudio/Chimera-AI-Console/commit/<sha>` and confirm GitHub has it. Deploy a **SHA** the first time, not `master`: you know exactly what is running, and nothing moves under you.

## 3. Create a read-only GitHub token

The repo is private, so the VM needs a token to download it. Create a **fine-grained personal access token**:

1. GitHub > your profile picture > Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token.
2. Resource owner: the account that owns the repo (`JoshFields-ChimeraStudio`). Repository access: **Only select repositories** > `Chimera-AI-Console`.
3. Permissions: Repository permissions > **Contents: Read-only** (Metadata read-only is added automatically). Nothing else.
4. Expiration: 7 to 30 days.
5. Copy the token. **Do not paste it into chat, a file in the repo, or the VM's shell profile.** You will type it into one SSH session only (step 5).

If the install later fails with a 404 or "Not Found" while downloading the source, the fine-grained token may not work with the download host. Try a **classic** token with the `repo` scope instead, and delete it afterwards.

Delete the token on GitHub once the install has succeeded. You create a new one for each later install or update.

## 4. Check the VM

Connect over the VPN, as the user that runs Paperclip (the `paperclip` user in your pilot notes).

```bash
ssh -i <your key> paperclip@<vm-private-ip>
```

**4.1 Basics**

```bash
node -v                   # must be v24.11 or higher
corepack --version
curl --version | head -1
tar --version | head -1
df -h /                   # want at least 15 GB free
free -h                   # note total RAM and swap
nproc
paperclipai --version
paperclipai service status
```

**4.2 Rust toolchain.** The server build compiles the Rust Runner (`paperclip-runnerd`), so `cargo` must exist. `build-essential` (the C linker) was installed in your pilot setup.

```bash
cargo --version
```

If that says "command not found", install Rust. The repo pins the exact version itself, so the minimal profile is enough:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"
cargo --version
```

The installer must find `cargo` on its `PATH`. `~/.cargo/env` is added to your login shell, so run the install from a normal SSH session, not from the service.

**4.3 Swap (recommended on 8 GB).** A release Rust build can use several GB, and an out-of-memory kill looks like a random build failure. If `free -h` shows no swap:

```bash
sudo fallocate -l 6G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
free -h
```

(This lasts until reboot. To keep it, add `/swapfile none swap sw 0 0` to `/etc/fstab`.)

**4.4 Outbound access.** The VM goes out through the NAT gateway. Check that it can reach the hosts the build uses:

```bash
for u in https://api.github.com https://codeload.github.com https://registry.npmjs.org https://static.rust-lang.org https://index.crates.io; do
  printf '%s ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 "$u"
done
```

Any code (200, 301, 404...) means it connected. A timeout means something is blocking that host and the build will fail on it.

## 5. Back up, then install

**5.1 Back up the database and the config** (do not print the config; it contains secrets):

```bash
paperclipai db:backup
ls -lt ~/.paperclip/instances/default/data/backups | head -3
cp ~/.paperclip/instances/default/config.json ~/config.json.pre-fork
chmod 600 ~/config.json.pre-fork
```

**5.2 Set the token for this session only and install.** Use the `paperclipai` already on the VM, and put the whole command on **one line**. Replace `<sha>` with the commit from step 2.3.

```bash
umask 022                              # Ubuntu's default 002 makes installed files group-writable, which the Copilot check rejects
read -rs GH_TOKEN && export GH_TOKEN      # paste the token, press Enter (nothing is echoed)
paperclipai install --yes --repo JoshFields-ChimeraStudio/Chimera-AI-Console --ref <sha>; echo "exit: $?"
unset GH_TOKEN
```

Do not use `npx paperclipai@latest install` here. On this VM `npx` exited with code 1 and printed nothing, so the installer never ran (the version stayed on the npm release).

What it does: resolves the SHA through the GitHub API, downloads the tarball, runs `pnpm install --frozen-lockfile`, builds the server and its dependencies, packs them, smoke-checks the CLI, and switches `~/.paperclip/cli/current` to the new payload. The previous payload is kept for rollback. Expect it to take a long time; watch the output rather than assuming it hung.

Add `--yes` for a non-interactive run. If it asks about updating your shell `PATH`, answer yes only if `paperclipai` is not already found.

**5.3 Restart the service.**

```bash
paperclipai --version                      # new version string
paperclipai service restart
paperclipai service status
```

If agents are running, use the guarded restart in `doc/DEVELOPING.md` ("Hot-Restart Deploys") instead of a plain restart.

## 6. Check that it worked

```bash
paperclipai doctor
curl -s http://127.0.0.1:3100/api/health
curl -sk https://<vm-private-ip>/api/health         # through Caddy
paperclipai service logs -n 100
jq '.telemetry' ~/.paperclip/instances/default/config.json    # enabled must be false
```

In the browser (on the VPN, `https://<vm-private-ip>`):

- [ ] Sign in works.
- [ ] The Dashboard shows the **Chimera AI Console** banner with your new marker (for example `vm-1`). That proves this is the fork.
- [ ] Open an existing agent (for example Tiamat) and run its environment test. It must pass. If you see `resolves outside the selected provider root`, the ACPX patch is not in the deployed commit. If you see `Paperclip Runner is unavailable`, run `paperclipai service restart` and retry.
- [ ] Wake one agent on a small task and watch it finish.

The telemetry check matters: a fresh install can bring the default back. If `.telemetry.enabled` is not `false`, set it again as in `../PAPERCLIP-PILOT.md` section 3.2 and restart.

## 7. Claude sign-in on the VM

The pilot signs in with your Claude subscription (`../PAPERCLIP-PILOT.md`, section 2.3). The install does not change `~/.claude` or the agents' stored settings, so existing agents should keep working. If a run fails with a sign-in error, sign in again on the VM (`claude`, then `/login`) or recreate the Claude connection in the Paperclip UI. Do not set `ANTHROPIC_API_KEY`.

## 8. Roll back

Program only (the previous payload is still on disk):

```bash
paperclipai update --rollback
paperclipai doctor
```

This switches `current` back and restarts the service. **It does not reverse database migrations.** If the new version changed the database and the old one cannot read it, you must restore the backup from step 5.1. This CLI has **no restore command**; restoring is a manual database operation. Before you need it, ask for help writing and testing the exact restore steps for this instance. Do not delete the backup until the new version has run cleanly for a few days.

## 9. Later updates

Two ways to keep the VM current:

- **Pinned (safer):** push, take the new SHA, and re-run step 5.2 with the new `--ref`. Nothing changes until you do.
- **Following the branch:** install once with `--ref master`. After that, `paperclipai update` re-resolves `master`, backs up the database, builds, switches and restarts.

```bash
paperclipai update --check        # exit code 10 means an update is available
paperclipai update
paperclipai update --rollback
```

Each update needs `GH_TOKEN` set in that session (same as step 5.2) while the repo is private.

## 10. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Install stops with `ENOENT ... server/ui-dist` or `server/skills` in `prepare-bundled-package.mjs` | Upstream's git install skips the server's `prepack` step (builds `server/ui-dist`) and its release step that copies the repo's `skills/` into the server package. This fork's `scripts/prepare-bundled-package.mjs` does both when missing. Deploy a commit that includes that change. |
| `npm pack ... prepack` fails with `Cannot resolve package from workspace` or `prepare-server-ui-dist.sh: No such file` | The staged server copy still had the source `prepack` hook. This fork's `scripts/prepare-bundled-package.mjs` removes `prepack`/`postpack` from the staged manifest. Deploy a commit that includes that change. |
| `npm install ... ETARGET No matching version found for @paperclipai/plugin-sdk@0.3.1` | Staged manifests pinned every `workspace:*` dependency to the depending package's version. This fork's `prepare-bundled-package.mjs` now uses each dependency's own version. Deploy a commit that includes that change. |
| `Copilot executable has unsafe permissions` during `npm install` (postinstall) | The shell umask is 002, so npm extracted the binary group-writable. Run `umask 022` in the same shell, delete the `.tmp-*` folders, and rerun the install. |
| `npx paperclipai@latest install ...` exits 1 with no output | `npx` fails silently on this VM. Use `paperclipai install ...` (step 5.2). |
| `--repo requires --ref` | Always pass both. |
| 404 or "Not Found" resolving the ref | Token missing, expired, or without Contents read on this repo. Recheck step 3; try a classic `repo` token. |
| `GitHub did not return a full commit SHA` | Ref misspelled or not pushed. Check the commit exists on GitHub. |
| `corepack: command not found` or pnpm errors | Node install is incomplete; reinstall Node 24 (`../PAPERCLIP-PILOT.md` 2.1). |
| `cargo`/`rustc` not found during the build | Do step 4.2, and run the install from a login shell. |
| Build killed, `Killed`, or exit 137 | Out of memory. Do step 4.3, or run the install with the service stopped to free RAM. |
| `error: linker 'cc' not found` | `sudo apt-get install -y build-essential`. |
| Download or `cargo` fetch times out | Outbound access blocked; recheck step 4.4. |
| `pnpm install --frozen-lockfile` fails | `pnpm-lock.yaml` is stale or missing in the commit. Run `pnpm install` locally, commit the lockfile, push, use the new SHA. |
| Service fails to start after install | `paperclipai service logs -n 200`, then `paperclipai update --rollback`. |
| `https://<ip>` loads but shows the old UI | Browser cache, or the service was not restarted. Hard-refresh; run `paperclipai service restart`. |
| Agent environment test: `resolves outside the selected provider root` | The commit lacks the ACPX fix in `installation-integrity.ts`. Deploy a commit that has it. |
| Agent environment test: `Paperclip Runner is unavailable...` | `paperclipai service restart`, then retry. |

## 11. Record what happened

Fill this in after the first real deploy, then trim this document to match.

- Date, commit SHA deployed, who ran it:
- Build time and peak memory:
- Did the build need Rust installed or swap added:
- Did the fine-grained token work, or was a classic token needed:
- Anything that differed from the steps above:
