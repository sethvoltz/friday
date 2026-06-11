# Self-Hosted Runner (Intel x64)

Friday's release tarballs are built per-architecture, on a runner of that architecture — native prebuilds (`@oxfmt/binding`, `@rocicorp/zero-sqlite3`, `better-sqlite3`, `sharp`) can't cross-compile (ADR-034). The `darwin-arm64` leg runs on GitHub's hosted `macos-latest`; the **`darwin-x64` (Intel) leg runs on a self-hosted runner** on an always-on Intel Mac, because GitHub's free hosted Intel pool (`macos-13`) proved unreliable and Intel hardware caps out at macOS 26 (no newer hosted image is coming).

This guide sets up that runner from scratch. The `release-publish.yml` x64 leg targets a runner registered with **exactly** the labels `self-hosted, macOS, X64, friday-intel`.

> **Why it's load-bearing:** the shared `VERSION` asset — the "latest" pointer every installer and `friday update` resolves — is gated on `needs: [publish]`, i.e. **both** arch legs succeeding. If this runner is offline or busy when a release-please Release PR merges, the x64 leg queues forever, no `VERSION` is published, and consumers correctly resolve "no new version yet." **Confirm the runner is online and idle before merging a Release PR** (see [Verify](#5-verify) below).

## Why no container

Self-hosted runners run jobs **directly on the host**, as the logged-in user, on the real filesystem — no ephemeral VM, no container (macOS doesn't support container jobs at all). Two consequences shape this guide:

- **Host state persists between jobs.** Homebrew packages, fnm's Node cache, and the pnpm store stick around, so host prerequisites are installed **once** (below) rather than re-provisioned per run.
- **The host environment _is_ the job environment.** A launchd-supervised runner inherits launchd's minimal `PATH` (which excludes `/usr/local/bin`), so we pin `PATH` explicitly (Step 2). pnpm and Node still come from the workflow's own `pnpm/action-setup` + `actions/setup-node` steps — only the items below are host responsibilities.

Never run untrusted fork PRs on this runner: it executes as your user with your privileges. Friday is safe by construction — PR validation runs on hosted `ubuntu-latest`, and `release-publish.yml` only fires `on: release: published` (from the release-please merge to `main`), never from a fork-triggered event.

## Prerequisites (on the Intel Mac)

Installed once; they persist. All three are **host** responsibilities the workflow assumes are present:

```bash
uname -m          # must print: x86_64   (confirms it's the Intel box)
git --version     # Xcode Command Line Tools; if it prompts to install, accept
brew --version    # Homebrew; on Intel it lives at /usr/local/bin/brew
brew install gh   # GitHub CLI — required by the upload step (see note)
```

- **git** — `actions/checkout` uses it. Ships with Xcode Command Line Tools (`xcode-select --install`).
- **Homebrew** — the job runs `brew install fnm` (the bundled `bin/friday` shim execs Node through fnm). If missing: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`.
- **gh** — the final job step is `gh release upload ...`. GitHub-_hosted_ runners bundle `gh`; **self-hosted ones do not**, so without it the upload step fails with `gh: command not found` (exit 127) _after_ a full successful build. **No `gh auth login` needed** — the job injects `GH_TOKEN: secrets.GITHUB_TOKEN`, an ephemeral repo-scoped token; the env var takes precedence over any stored login and never writes to `~/.config/gh`, so installing `gh` here does not interfere with (and is not interfered by) any personal `gh` login on the machine.

## Setup

### 1. Download + verify + extract the runner

Fetch the current runner version and its checksum dynamically so this doesn't rot:

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner

# Resolve the latest runner version + osx-x64 asset/sha (run on any machine with gh)
VER="$(gh api /repos/actions/runner/releases/latest --jq '.tag_name' | sed 's/^v//')"
ASSET="actions-runner-osx-x64-${VER}.tar.gz"
SHA="$(gh api /repos/actions/runner/releases/latest --jq '.body' | grep -i "$ASSET" | grep -ioE '[a-f0-9]{64}' | head -1)"

curl -fsSL -o "$ASSET" "https://github.com/actions/runner/releases/download/v${VER}/${ASSET}"
echo "${SHA}  ${ASSET}" | shasum -a 256 -c    # must print: <asset>: OK
tar xzf "$ASSET"
```

### 2. Pin the service PATH (so `brew`/`fnm`/`gh` resolve under launchd)

A launchd service's default `PATH` excludes `/usr/local/bin`, where Homebrew (and the tools it installs) live. The runner reads a `.path` file at service start and uses it verbatim. Capture your **interactive** shell's `PATH` (the one where `brew` works):

```bash
echo "$PATH" > ~/actions-runner/.path
grep -q "/usr/local/bin" ~/actions-runner/.path && echo "PATH ok" || echo "WARNING: /usr/local/bin missing"
```

Must print `PATH ok`. Without this, the in-job `brew install fnm` fails with "command not found."

### 3. Register the runner

Mint a short-lived (1 hour) registration token — from any machine with `gh` and repo admin:

```bash
gh api -X POST /repos/sethvoltz/friday/actions/runners/registration-token --jq '.token'
```

Then register on the Intel Mac:

```bash
cd ~/actions-runner
./config.sh \
  --url https://github.com/sethvoltz/friday \
  --token <REGISTRATION_TOKEN> \
  --name friday-intel \
  --labels friday-intel \
  --work _work \
  --unattended --replace
```

`self-hosted`, `macOS`, and `X64` are auto-applied from the OS/arch; `--labels friday-intel` adds the fourth — yielding exactly the `[self-hosted, macOS, X64, friday-intel]` set the workflow targets. `--replace` lets you re-register over an existing runner of the same name.

### 4. Install as an always-on launchd service

```bash
cd ~/actions-runner
./svc.sh install
./svc.sh start
./svc.sh status     # expect: Started: <pid> 0 actions.runner.sethvoltz-friday.friday-intel
```

`svc.sh` installs a **LaunchAgent** (`~/Library/LaunchAgents/actions.runner.sethvoltz-friday.friday-intel.plist`), which only runs while the user is logged into a GUI session. For an unattended always-on box:

- **Enable automatic login** — System Settings → Users & Groups → "Automatically log in as" → this user. This reloads the LaunchAgent after a reboot without anyone at the keyboard. (FileVault, if enabled, blocks auto-login at the pre-boot unlock screen — leave it unlocked or accept one manual unlock per reboot.)
- **Disable sleep** — a sleeping Mac is an offline runner:

  ```bash
  sudo pmset -a sleep 0 disablesleep 1 autorestart 1
  ```

  `sleep 0` (never idle-sleep) is the load-bearing one. `disablesleep 1` keeps it running lid-closed without an external display. `autorestart 1` reboots after power loss — unsupported on some MacBook models (pmset silently ignores it; the battery bridges short outages anyway). `disablesleep` never renders in `pmset -g` output; the real test is empirical (lid closed → runner stays online).

### 5. Verify

From any machine with `gh`:

```bash
gh api /repos/sethvoltz/friday/actions/runners \
  --jq '.runners[] | "\(.name) \(.status) busy=\(.busy) labels=[\([.labels[].name] | join(", "))]"'
```

Expect:

```
friday-intel online busy=false labels=[self-hosted, macOS, X64, friday-intel]
```

This same one-liner is the pre-flight check before merging any release-please Release PR.

## Troubleshooting a failed x64 release leg

The x64 leg runs the full release chain — checkout → `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm install --prod` → `node packaging/pack.mjs` → `brew install fnm` → five relocation/native-addon smoke tests → `gh release upload`. Pull the failing step's log:

```bash
RUN=$(gh run list --repo sethvoltz/friday --workflow "Release Publish" --limit 1 --json databaseId --jq '.[0].databaseId')
JOB=$(gh run view "$RUN" --repo sethvoltz/friday --json jobs --jq '.jobs[] | select(.name | test("x64")) | .databaseId')
gh run view --repo sethvoltz/friday --job "$JOB" --log-failed | tail -40
```

Common host-side failures (all stem from this being bare-metal-on-host, not an ephemeral image):

| Symptom                                                 | Cause                                    | Fix                                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `brew: command not found` (during `Install fnm`)        | `.path` doesn't include `/usr/local/bin` | Re-run Step 2 from an interactive shell                                                                                        |
| `gh: command not found` (during `Upload ...`, exit 127) | `gh` not installed on the host           | `brew install gh` (no auth needed)                                                                                             |
| `sharp` / `zero-sqlite3` native-addon smoke fails       | x64 prebuild ABI mismatch                | This is the runner doing its job — the smoke caught a broken tarball before upload; investigate the dependency, not the runner |
| x64 leg never starts (queued forever)                   | runner offline/busy                      | Check Step 5; `./svc.sh status` on the host; ensure the Mac isn't asleep                                                       |

After fixing a host prerequisite, re-run just the failed leg (the `publish-version` job re-runs automatically once both legs are green):

```bash
gh run rerun <run-id> --repo sethvoltz/friday --failed
```

## Re-registering / removing the runner

```bash
# remove the service + deregister (token from the same registration-token endpoint, or use a remove-token)
cd ~/actions-runner
sudo ./svc.sh uninstall
./config.sh remove --token <REMOVE_OR_REGISTRATION_TOKEN>
```

A remove token comes from `gh api -X POST /repos/sethvoltz/friday/actions/runners/remove-token --jq '.token'`. To rotate hardware, remove the old runner and repeat Setup on the new box with the same `--name friday-intel` and labels.
