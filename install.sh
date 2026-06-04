#!/usr/bin/env bash
#
# Friday installer (FRI-146 / ADR-034).
#
#   curl -fsSL https://raw.githubusercontent.com/sethvoltz/friday/main/install.sh | bash
#
# Downloads the pre-baked per-platform tarball from the latest GitHub
# release, verifies its sha256, extracts it into a self-owned versioned
# dir, provisions the pinned Node via fnm, shims `friday` onto PATH, and
# writes + bootstraps the launchd supervisor plist directly (no
# brew-services). Re-running updates in place — idempotent.
#
# This is the bash twin of the CLI's `friday update` / launchd helpers.
# The launchd plist + on-device tree layout MUST stay byte-for-byte in
# sync with:
#   packages/cli/src/lib/launchd.ts        (renderPlist / bootstrap)
#   packages/cli/src/lib/install-paths.ts  (installRoot / versionsDir / …)
#   packages/cli/src/commands/update.ts    (flipCurrent — RELATIVE symlink)
#
# Constraints (do not regress):
#   * Must parse + run under macOS system bash 3.2.57. NO bash-4 features:
#     no associative arrays, no bulk array-reads from a file, no
#     case-modification parameter expansion, no `&>>`. `[[ =~ ]]` +
#     BASH_REMATCH are fine in 3.2.
#   * macOS only: darwin-arm64 (Apple Silicon, primary) + darwin-x64 (Intel,
#     legacy). The asset-name dispatch is also shaped for a future Linux row
#     but only the two darwin arches are accepted.
#   * The shim + plist both invoke an in-place exec to the fnm-resolved
#     pinned node — fnm is the runtime resolver, not a long-lived wrapper.
#     The only absolute Node-toolchain path written anywhere is
#     `$(brew --prefix)/bin/fnm`. fnm's internal per-version node path is
#     never written or baked.

set -euo pipefail

# Staging dir for download + verify; assigned in main(). Declared (empty)
# at global scope so the EXIT trap can clean it up under `set -u`, then
# wired up before any work happens.
STAGE=""
cleanup() { if [ -n "${STAGE}" ]; then rm -rf "${STAGE}"; fi; }
trap cleanup EXIT

# ---- constants --------------------------------------------------------

GITHUB_REPO="sethvoltz/friday"
RELEASE_BASE="https://github.com/${GITHUB_REPO}/releases/latest/download"

# Brewfile-tracked third-party deps (Friday itself is NOT brew-managed).
# Postgres + cloudflared + gh + pnpm + fnm stay brew deps. Claude Code is
# not installed here; `friday doctor` checks for `claude` on PATH.
BREW_DEPS="fnm pnpm postgresql@18 cloudflared gh"

LAUNCHD_LABEL="com.sethvoltz.friday"

# ---- output helpers ---------------------------------------------------

# Colorize only when stdout is a TTY (curl|bash pipes a non-tty).
if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''; C_RESET=''
fi

info()  { printf '%s\n' "${C_DIM}  $*${C_RESET}"; }
step()  { printf '%s\n' "${C_BOLD}$*${C_RESET}"; }
ok()    { printf '%s\n' "${C_GREEN}✓ $*${C_RESET}"; }
warn()  { printf '%s\n' "${C_YELLOW}! $*${C_RESET}" >&2; }
fail()  { printf '%s\n' "${C_RED}✗ $*${C_RESET}" >&2; exit 1; }

# ---- paths ------------------------------------------------------------
# Mirror install-paths.ts exactly. Data dir honors FRIDAY_DATA_DIR so the
# plist's log paths match the CLI's LOGS_DIR resolution.

INSTALL_ROOT="${HOME}/.local/share/friday"
VERSIONS_DIR="${INSTALL_ROOT}/versions"
CURRENT_LINK="${INSTALL_ROOT}/current"
BIN_DIR="${HOME}/.local/bin"
SHIM_PATH="${BIN_DIR}/friday"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
DATA_DIR="${FRIDAY_DATA_DIR:-${HOME}/.friday}"
LOGS_DIR="${DATA_DIR}/logs"

# ---- 1. platform detection -------------------------------------------

detect_platform() {
  local uname_s uname_m os arch
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"

  case "${uname_s}" in
    Darwin) os="darwin" ;;
    *) fail "unsupported OS '${uname_s}' — Friday v1 supports macOS (Darwin) only." ;;
  esac

  case "${uname_m}" in
    arm64|aarch64) arch="arm64" ;;
    x86_64) arch="x64" ;;
    *) fail "unsupported architecture '${uname_m}' — Friday supports Apple Silicon (arm64) and Intel (x64)." ;;
  esac

  # Asset-name shape is also designed for a future Linux row; today Friday
  # builds + accepts the two darwin arches (arm64 primary, x64 legacy).
  PLATFORM="${os}-${arch}"
  case "${PLATFORM}" in
    darwin-arm64|darwin-x64) : ;;
    *) fail "no release asset for platform '${PLATFORM}' — Friday ships darwin-arm64 and darwin-x64." ;;
  esac
  TARBALL_NAME="friday-${PLATFORM}.tar.gz"
  SHA_NAME="${TARBALL_NAME}.sha256"
}

# ---- 2. dependency provisioning --------------------------------------

ensure_brew() {
  if ! command -v brew >/dev/null 2>&1; then
    fail "Homebrew not found. Install it from https://brew.sh, then re-run this installer."
  fi
}

ensure_brew_deps() {
  # Friday relies on brew for its third-party deps. Install any that are
  # missing; if the repo's Brewfile is reachable (dev checkout / extracted
  # tree) prefer `brew bundle`, else install each dep individually.
  local missing dep
  missing=""
  for dep in ${BREW_DEPS}; do
    if ! brew list "${dep}" >/dev/null 2>&1; then
      missing="${missing} ${dep}"
    fi
  done

  if [ -n "${missing}" ]; then
    info "installing missing brew deps:${missing}"
    for dep in ${BREW_DEPS}; do
      if ! brew list "${dep}" >/dev/null 2>&1; then
        brew install "${dep}" || warn "brew install ${dep} failed — install it manually"
      fi
    done
  fi

  if ! command -v claude >/dev/null 2>&1; then
    warn "claude CLI not found on PATH"
    info "install via Anthropic (curl -fsSL https://claude.ai/install.sh | bash)"
    info "or brew: brew install --cask claude-code"
    info "details: https://docs.anthropic.com/en/docs/claude-code"
  fi
}

ensure_fnm() {
  if command -v fnm >/dev/null 2>&1; then
    return 0
  fi
  # fnm is a Brewfile dep; ensure_brew_deps should have installed it. As a
  # belt-and-braces fallback, install it directly.
  info "installing fnm via brew"
  brew install fnm || fail "could not install fnm — install it with \`brew install fnm\` and re-run."
}

# Provision the pinned Node by running `fnm install` from the install dir
# so it reads the extracted tree's .node-version (no Node tarball is
# vendored, fnm's internal path is never baked).
provision_node() {
  local install_dir="$1"
  local fnm_bin
  fnm_bin="$(brew --prefix)/bin/fnm"
  if [ ! -x "${fnm_bin}" ]; then
    fail "fnm not found at ${fnm_bin} — install it with \`brew install fnm\`."
  fi
  info "provisioning pinned Node via fnm (reads .node-version)"
  ( cd "${install_dir}" && "${fnm_bin}" install ) \
    || fail "fnm install failed — could not provision the pinned Node version."
}

# ---- 3. version resolution + download + verify -----------------------

# Resolve the latest published version via the release-asset redirect
# (no auth, no JSON parsing). The VERSION asset is plain text.
#
# The resolved string becomes a filesystem path segment downstream
# (VERSIONS_DIR/<version>, `ln -sfn versions/<version> …`), so it MUST be
# validated against a strict semver shape BEFORE it is ever joined into a
# path. `tr -d '[:space:]'` strips whitespace but NOT `/` or `..`; a payload
# like `../../../tmp/x` would otherwise escape the versions/ dir and point
# `current` — then the launchd-executed tree — at an arbitrary path. `[[ =~ ]]`
# + BASH_REMATCH are fine on bash 3.2. Mirrors update.ts:assertValidVersion.
resolve_version() {
  local version
  version="$(curl -fsSL "${RELEASE_BASE}/VERSION" | tr -d '[:space:]')"
  if [ -z "${version}" ]; then
    fail "could not resolve the latest Friday version from ${RELEASE_BASE}/VERSION"
  fi
  if [[ ! "${version}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
    fail "refusing to install untrusted version string '${version}' — not a valid semver release version."
  fi
  printf '%s' "${version}"
}

# Download tarball + .sha256 into $1 (a temp dir). Sets DL_TARBALL/DL_SHA.
download_release() {
  local dest="$1"
  DL_TARBALL="${dest}/${TARBALL_NAME}"
  DL_SHA="${dest}/${SHA_NAME}"
  info "downloading ${TARBALL_NAME}"
  curl -fsSL "${RELEASE_BASE}/${TARBALL_NAME}" -o "${DL_TARBALL}" \
    || fail "download failed: ${RELEASE_BASE}/${TARBALL_NAME}"
  curl -fsSL "${RELEASE_BASE}/${SHA_NAME}" -o "${DL_SHA}" \
    || fail "download failed: ${RELEASE_BASE}/${SHA_NAME}"
}

# Verify DL_TARBALL against DL_SHA using `shasum -a 256` (stock macOS ships
# /usr/bin/shasum; the GNU coreutils digest tool is NOT guaranteed present).
# Exits non-zero on mismatch — the caller stages into a temp dir so a
# mismatch never leaves a versions/<v>/ dir behind.
verify_sha256() {
  local expected actual
  # The .sha256 file may be either a bare digest or `<digest>  <filename>`.
  expected="$(awk '{print $1}' "${DL_SHA}" | tr -d '[:space:]')"
  actual="$(shasum -a 256 "${DL_TARBALL}" | awk '{print $1}')"
  if [ -z "${expected}" ]; then
    fail "sha256 file ${DL_SHA} is empty or unreadable — refusing to install."
  fi
  if [ "${expected}" != "${actual}" ]; then
    fail "sha256 mismatch — refusing to install. expected ${expected}, got ${actual}"
  fi
  info "sha256 verified ($(printf '%s' "${actual}" | cut -c1-12)…)"
}

# ---- 4. extract + flip ------------------------------------------------

# Extract the verified tarball into versions/<version>/. Stages the
# extraction in a temp dir and only moves it into place on success, so a
# failed/interrupted extract never leaves a half-written version dir.
extract_release() {
  local version="$1" tarball="$2" stage="$3"
  local target extract_stage
  target="${VERSIONS_DIR}/${version}"
  extract_stage="${stage}/tree"

  if [ -d "${target}" ]; then
    info "version ${version} already extracted — reusing"
    return 0
  fi

  mkdir -p "${extract_stage}"
  tar -xzf "${tarball}" -C "${extract_stage}" \
    || fail "tar extract failed for ${tarball}"

  mkdir -p "${VERSIONS_DIR}"
  mv -f "${extract_stage}" "${target}" \
    || fail "could not move extracted tree into ${target}"
}

# Atomically flip current -> versions/<version>. The symlink target is
# stored RELATIVE (`versions/<version>`) so the whole install root stays
# relocatable — this MUST match update.ts:flipCurrent.
flip_current() {
  local version="$1"
  local tmp="${CURRENT_LINK}.tmp"
  rm -f "${tmp}"
  ln -sfn "versions/${version}" "${tmp}"
  mv -f "${tmp}" "${CURRENT_LINK}"
}

# ---- 5. PATH shim -----------------------------------------------------

# Write ~/.local/bin/friday — a shim that resolves the pinned Node via fnm
# and execs node IN PLACE so no fnm wrapper sits on the process tree.
# Mirrors bin/friday in the source repo.
write_shim() {
  mkdir -p "${BIN_DIR}"
  cat > "${SHIM_PATH}" <<'SHIM'
#!/usr/bin/env bash
# Friday CLI shim — written by install.sh (FRI-146 / ADR-034). Resolves the
# install tree via the `current` symlink so `friday update` flips take
# effect immediately. fnm reads .node-version from CWD (no parent walk), so
# we cd into the install root — which holds .node-version (packed by
# pack.mjs) — before exec'ing.
set -euo pipefail
DIR="$HOME/.local/share/friday/current"
cd "$DIR"
NODE_BIN="$("$(brew --prefix)/bin/fnm" exec -- command -v node)"
exec "$NODE_BIN" "packages/cli/dist/index.js" "$@"
SHIM
  chmod +x "${SHIM_PATH}"

  # Warn (don't fail) if ~/.local/bin is not on PATH.
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) : ;;
    *)
      warn "${BIN_DIR} is not on your PATH."
      info "add it to your shell profile (~/.zshrc or ~/.bashrc):"
      info "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac
}

# ---- 6. launchd plist -------------------------------------------------

# Write ~/Library/LaunchAgents/com.sethvoltz.friday.plist. MUST match
# launchd.ts:renderPlist — same label, ProgramArguments shape
# ([<current>/bin/friday-supervisor]), WorkingDirectory = the `current`
# symlink dir (matches start.ts passing currentLink()), RunAtLoad +
# KeepAlive, StandardOut/ErrPath under LOGS_DIR.
#
# `EnvironmentVariables.FRIDAY_FNM_BIN` is resolved here at install time —
# install.sh runs in the user's interactive shell where brew is on PATH, so
# `$(brew --prefix)/bin/fnm` evaluates to a real absolute path and gets
# baked into the plist. launchd-spawned processes don't inherit user PATH,
# so we hand the supervisor shim the resolved fnm location via env rather
# than relying on PATH lookup. The shim resolves the pinned Node via that
# fnm and execs node IN PLACE — fnm is the runtime resolver, not a long-
# lived wrapper. `friday doctor` verifies the baked binary is a real exec.
write_plist() {
  local supervisor_shim fnm_bin
  supervisor_shim="${CURRENT_LINK}/bin/friday-supervisor"
  fnm_bin="$(brew --prefix)/bin/fnm"

  mkdir -p "${LOGS_DIR}"
  mkdir -p "$(dirname "${PLIST_PATH}")"

  cat > "${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${supervisor_shim}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FRIDAY_FNM_BIN</key>
    <string>${fnm_bin}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${CURRENT_LINK}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOGS_DIR}/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOGS_DIR}/launchd.err.log</string>
</dict>
</plist>
PLIST
}

# Bootstrap (or re-bootstrap) the launchd job. Idempotent: bootout any
# prior instance first so a re-run picks up the freshly written plist,
# then bootstrap + kickstart. Matches launchd.ts:bootstrap semantics.
bootstrap_launchd() {
  local uid domain service
  uid="$(id -u)"
  domain="gui/${uid}"
  service="${domain}/${LAUNCHD_LABEL}"

  # Best-effort unload of any prior instance (no-op if not loaded).
  launchctl bootout "${service}" >/dev/null 2>&1 || true

  if ! launchctl bootstrap "${domain}" "${PLIST_PATH}"; then
    warn "launchctl bootstrap failed — the plist is written at ${PLIST_PATH}."
    info "start manually with: friday start"
    return 0
  fi
  # Force an immediate (re)start now that it's loaded.
  launchctl kickstart -k "${service}" >/dev/null 2>&1 || true
}

# ---- main -------------------------------------------------------------

main() {
  step "Installing Friday"

  detect_platform
  info "platform ${PLATFORM}"

  ensure_brew
  ensure_brew_deps
  ensure_fnm

  local version target
  version="$(resolve_version)"
  target="${VERSIONS_DIR}/${version}"
  step "Friday ${version}"

  # Stage download + verify in a temp dir so a failed verify/extract leaves
  # no versions/<v>/ behind. STAGE is a global (not `local`) so the EXIT
  # trap — which fires in the global scope after main() returns — can still
  # read it under `set -u`. The cleanup is guarded on a non-empty value.
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/friday-install.XXXXXX")"

  if [ -d "${target}" ]; then
    # Already extracted (prior run / reinstall) — skip download, just
    # re-provision Node, flip, and re-register the supervisor.
    info "version ${version} already present — reconciling install"
  else
    download_release "${STAGE}"
    verify_sha256
    extract_release "${version}" "${DL_TARBALL}" "${STAGE}"
  fi

  provision_node "${target}"
  flip_current "${version}"
  write_shim
  write_plist
  bootstrap_launchd

  ok "Friday ${version} installed"
  info "tree    ${target}"
  info "current ${CURRENT_LINK} -> versions/${version}"
  info "shim    ${SHIM_PATH}"
  info "plist   ${PLIST_PATH}"
  printf '%s\n' "${C_DIM}  manage with: friday start | friday status | friday update${C_RESET}"
}

main "$@"
