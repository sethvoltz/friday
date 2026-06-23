<script lang="ts">
  import type { PageData } from "./$types";
  import { invalidateAll } from "$app/navigation";
  import { confirmDialog } from "$lib/components/ConfirmDialog/store.svelte";
  import { Monitor } from "lucide-svelte";
  import { useZero, zeroSync } from "$lib/stores/zero.svelte";
  import { theme, type ThemeKind } from "$lib/stores/theme.svelte";
  import { DEFAULTS, PALETTES, type PaletteName } from "$lib/theme/palettes";
  import PalettePreview from "$lib/components/Appearance/PalettePreview.svelte";
  import CaptureKeys from "$lib/components/Settings/CaptureKeys.svelte";
  import NotificationSettings from "$lib/components/Settings/NotificationSettings.svelte";

  import Toggle from "$lib/components/Toggle/Toggle.svelte";
  import {
    wakeLockSettings,
    wakeLockState,
  } from "$lib/stores/wake-lock.svelte";
  // Runtime imports of @friday/shared in client code must go through the
  // browser-safe `sync` surface — the root barrel re-exports node-only
  // modules (db/client.js → pg, env.js → dotenv, config.js → node:os) that
  // Vite stubs to empty modules, crashing every page at hydration. Types
  // from the root are fine: `import type` is fully erased.
  import { coerceLegacyModelId } from "@friday/shared/sync";
  import { PUBLIC_APP_VERSION } from "$env/static/public";
  import type {
    AgentTypeName,
    EvolveTaskName,
    ModelConfig,
  } from "@friday/shared";
  import type { AppSummary } from "./+page.server";
  let { data }: { data: PageData } = $props();

  // Phase 3.4 (ADR-024): when the Zero flag is on, derive the
  // installed-apps panel from `zeroSync.apps` joined against
  // `zeroSync.agents` + `zeroSync.schedules` (already reactive).
  // Falls back to the SSR-loaded `data.apps` when the flag is off.
  const zeroOn = useZero();
  const apps = $derived.by<AppSummary[]>(() => {
    if (!zeroOn) return data.apps;
    const allAgents = zeroSync.agents;
    const allSchedules = zeroSync.schedules;
    return zeroSync.apps.map((r) => {
      const manifest = r.manifest_json ?? null;
      return {
        id: r.id,
        name: r.name,
        version: r.version,
        status: r.status,
        installedAt: r.installed_at,
        folderPath: r.folder_path,
        agents: allAgents
          .filter((a) => a.app_id === r.id)
          .map((a) => ({ name: a.name, type: a.type, status: a.status })),
        schedules: allSchedules
          .filter((s) => s.app_id === r.id)
          .map((s) => ({ name: s.name, cron: s.cron })),
        mcpServers: (manifest?.mcpServers ?? []).map((m) => ({
          name: m.name,
        })),
      };
    });
  });

  // Hydrate the wake-lock setting on first paint (SSR-safe: hydrate() reads
  // localStorage behind a typeof guard).
  wakeLockSettings.hydrate();

  let wakeLockEnabled = $state(wakeLockSettings.enabled);
  $effect(() => {
    if (wakeLockEnabled !== wakeLockSettings.enabled) {
      wakeLockSettings.set(wakeLockEnabled);
    }
  });

  // FRI-124: Appearance card — Single/Sync + per-slot palette picks.
  // Reads from the runtime theme store (zero-synced); writes through
  // zeroSync.updateSettings so the canonical state in Postgres updates
  // and other devices/tabs pick it up via Zero replication.
  const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];
  // Names look better capitalized in the UI than as token-strings.
  function displayName(name: PaletteName): string {
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  function setThemeKind(kind: ThemeKind): void {
    theme.setKind(kind);
    zeroSync.updateSettings({ themeKind: kind });
  }
  function setSinglePick(name: PaletteName): void {
    theme.setSinglePick(name);
    zeroSync.updateSettings({ themePaletteSingle: name });
  }
  function setSlotPick(slot: "light" | "dark", name: PaletteName): void {
    theme.setSlotPick(slot, name);
    if (slot === "light") zeroSync.updateSettings({ themePaletteLight: name });
    else zeroSync.updateSettings({ themePaletteDark: name });
  }

  // FIX_FORWARD 6.3 + Phase 4.3: configurable Friday settings (model +
  // watchdog). Under Zero (`useZero()`), the live values come from the
  // reactive `zeroSync.settings` singleton row and writes go through
  // the `updateSettings` mutator; the daemon's LISTEN handler re-syncs
  // ~/.friday/config.json so worker spawns see the new value on the
  // next read (no restart required). The SSR `data.settings` seed
  // covers first paint before Zero's WS handshake completes.
  // FRI-16: collapse a jsonb override map (values are bare model-id
  // strings or {name, …} ModelConfig objects) to picker-ready names.
  // Legacy ids coerce to their dated form so a stored
  // `claude-haiku-4-5` still selects the matching MODEL_OPTIONS entry.
  function overrideNames<K extends string>(
    map: Partial<Record<K, string | ModelConfig>> | null | undefined,
  ): Partial<Record<K, string>> {
    const out: Partial<Record<K, string>> = {};
    for (const [key, value] of Object.entries(map ?? {})) {
      if (value == null) continue;
      out[key as K] = coerceLegacyModelId(
        typeof value === "string" ? value : (value as ModelConfig).name,
      );
    }
    return out;
  }

  const liveSettings = $derived.by<{
    model: string;
    watchdogRefork: boolean;
    models: Partial<Record<AgentTypeName, string>>;
    evolveModels: Partial<Record<EvolveTaskName, string>>;
  }>(() => {
    if (!zeroOn) {
      return {
        model: data.settings.model,
        watchdogRefork: data.settings.watchdogRefork,
        models: data.settings.models,
        evolveModels: data.settings.evolveModels,
      };
    }
    const row = zeroSync.settings[0];
    return {
      // Coerce on display too — a row written before the dated-id
      // standardization (FRI-16 AC #22b) may still carry the legacy id.
      model: row?.model != null ? coerceLegacyModelId(row.model) : data.settings.model,
      watchdogRefork: row?.watchdog_refork ?? data.settings.watchdogRefork,
      models: row ? overrideNames(row.models) : data.settings.models,
      evolveModels: row ? overrideNames(row.evolve_models) : data.settings.evolveModels,
    };
  });
  // Two-way bindings for the form inputs. `$effect` mirrors the
  // derived live values into the writable state so cross-tab updates
  // converge the inputs without trampling an in-progress edit.
  // svelte-ignore state_referenced_locally
  let model = $state(data.settings.model);
  // svelte-ignore state_referenced_locally
  let watchdogRefork = $state(data.settings.watchdogRefork);
  // svelte-ignore state_referenced_locally
  let roleModels = $state<Partial<Record<AgentTypeName, string>>>({
    ...data.settings.models,
  });
  // svelte-ignore state_referenced_locally
  let evolveModels = $state<Partial<Record<EvolveTaskName, string>>>({
    ...data.settings.evolveModels,
  });
  let savingSettings = $state(false);
  let reloadState = $state<Record<string, "idle" | "loading" | "ok" | "error">>({});

  $effect(() => {
    if (!zeroOn) return;
    if (savingSettings) return; // don't trample an in-flight save
    model = liveSettings.model;
    watchdogRefork = liveSettings.watchdogRefork;
    roleModels = liveSettings.models;
    evolveModels = liveSettings.evolveModels;
  });

  const MODEL_OPTIONS: Array<{ id: string; label: string }> = [
    { id: "claude-opus-4-8", label: "Claude Opus 4.8 — best for reasoning" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7 — prior tier" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — balanced" },
    {
      id: "claude-haiku-4-5-20251001",
      label: "Claude Haiku 4.5 — fastest / cheapest",
    },
  ];

  // FRI-16: one picker per agent role + per evolve internal LLM pass.
  // A missing key in the corresponding map means "use the global
  // default" — the daemon resolves via resolveModelForRole /
  // resolveModelForEvolveTask with cfg.model as the fallthrough.
  const ROLE_PICKERS: Array<{ role: AgentTypeName; label: string }> = [
    { role: "orchestrator", label: "Orchestrator" },
    { role: "builder", label: "Builder" },
    { role: "helper", label: "Helper" },
    { role: "planner", label: "Planner" },
    { role: "scheduled", label: "Scheduled" },
    { role: "bare", label: "Bare" },
  ];
  const EVOLVE_PICKERS: Array<{ task: EvolveTaskName; label: string }> = [
    { task: "enrich", label: "Enrich" },
    { task: "scanFriction", label: "Scan friction" },
    { task: "scanPreferences", label: "Scan preferences" },
  ];

  // svelte-ignore state_referenced_locally
  let priorModel = $state(data.settings.model);
  // svelte-ignore state_referenced_locally
  let priorWatchdog = $state(data.settings.watchdogRefork);
  // svelte-ignore state_referenced_locally
  let priorRoleModels = $state<Partial<Record<AgentTypeName, string>>>({
    ...data.settings.models,
  });
  // svelte-ignore state_referenced_locally
  let priorEvolveModels = $state<Partial<Record<EvolveTaskName, string>>>({
    ...data.settings.evolveModels,
  });
  let settingsToast = $state<{ msg: string; kind: "ok" | "err" } | null>(null);

  function showSettingsToast(msg: string, kind: "ok" | "err") {
    settingsToast = { msg, kind };
    setTimeout(() => {
      settingsToast = null;
    }, 4500);
  }

  async function patchSettings(body: {
    model?: string;
    watchdogRefork?: boolean;
    models?: Partial<Record<AgentTypeName, string>> | null;
    evolveModels?: Partial<Record<EvolveTaskName, string>> | null;
  }) {
    savingSettings = true;
    try {
      if (zeroOn) {
        // Phase 4.3: write via the Zero mutator. Optimistic client
        // write lands immediately; the canonical Postgres UPSERT and
        // daemon's LISTEN-driven config.json resync follow within a
        // second. The reactive `$effect` above will mirror the new
        // values back into the inputs once they arrive — until then
        // the inputs reflect the user's keystrokes.
        zeroSync.updateSettings(body);
        priorModel = body.model ?? priorModel;
        priorWatchdog = body.watchdogRefork ?? priorWatchdog;
        if (body.models !== undefined) priorRoleModels = body.models ?? {};
        if (body.evolveModels !== undefined) {
          priorEvolveModels = body.evolveModels ?? {};
        }
        showSettingsToast("saved", "ok");
        return;
      }
      // Legacy REST path — only reachable with Zero disabled.
      let r: Response;
      try {
        r = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        model = priorModel;
        watchdogRefork = priorWatchdog;
        roleModels = { ...priorRoleModels };
        evolveModels = { ...priorEvolveModels };
        showSettingsToast(
          `save failed: ${err instanceof Error ? err.message : String(err)}`,
          "err",
        );
        return;
      }
      if (!r.ok) {
        const detail = await r
          .json()
          .then((j: { detail?: string }) => j.detail)
          .catch(() => null);
        model = priorModel;
        watchdogRefork = priorWatchdog;
        roleModels = { ...priorRoleModels };
        evolveModels = { ...priorEvolveModels };
        showSettingsToast(
          detail ? `save failed: ${detail}` : `save failed (${r.status})`,
          "err",
        );
        return;
      }
      const fresh = (await r.json()) as {
        model: string;
        watchdogRefork: boolean;
        models: Partial<Record<AgentTypeName, string>>;
        evolveModels: Partial<Record<EvolveTaskName, string>>;
      };
      model = fresh.model;
      watchdogRefork = fresh.watchdogRefork;
      roleModels = fresh.models;
      evolveModels = fresh.evolveModels;
      priorModel = fresh.model;
      priorWatchdog = fresh.watchdogRefork;
      priorRoleModels = fresh.models;
      priorEvolveModels = fresh.evolveModels;
      showSettingsToast("saved · restart daemon for changes to take effect", "ok");
    } finally {
      savingSettings = false;
    }
  }

  async function onModelChange(e: Event) {
    const next = (e.target as HTMLSelectElement).value;
    await patchSettings({ model: next });
  }

  /** FRI-16: per-role override picker. "Use default" (the empty option)
   *  removes the role's key; the patch carries the whole replacement map
   *  per the updateSettings contract. Clearing the last override emits
   *  `{}` (NOT `null`): the daemon listener treats a NULL column as
   *  "never configured — preserve config.json", so an empty map is the
   *  shape that actually clears `cfg.models` on the Zero path. */
  async function onRoleModelChange(role: AgentTypeName, e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    const next = { ...roleModels };
    if (value === "") delete next[role];
    else next[role] = value;
    roleModels = next;
    await patchSettings({ models: next });
  }

  /** FRI-16: per-evolve-task override picker — same contract as roles. */
  async function onEvolveModelChange(task: EvolveTaskName, e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    const next = { ...evolveModels };
    if (value === "") delete next[task];
    else next[task] = value;
    evolveModels = next;
    await patchSettings({ evolveModels: next });
  }

  // Toggle uses bind:checked, so we react to mutations via $effect instead
  // of a DOM change handler. Skip the firing that happens on mount with
  // the initial value by comparing against the last-committed value.
  $effect(() => {
    if (watchdogRefork === priorWatchdog) return;
    void patchSettings({ watchdogRefork });
  });

  // FIX_FORWARD 6.3: nuke every auth:* rate-limit bucket. Gated since the
  // operator should explicitly acknowledge they're unlocking the sign-in
  // surface.
  async function resetAuthLimits() {
    const ok = await confirmDialog({
      title: "Clear auth rate-limits?",
      description:
        "Clear every auth rate-limit and lockout? Pending sign-in attempts will start from zero.",
      confirmLabel: "Clear",
      danger: true,
    });
    if (!ok) return;
    const r = await fetch("/api/settings/reset-auth-limits", {
      method: "POST",
    });
    if (r.ok) {
      const { cleared } = (await r.json()) as { cleared: number };
      alert(
        cleared > 0
          ? `Cleared ${cleared} rate-limit entr${cleared === 1 ? "y" : "ies"}.`
          : "No pending rate-limit entries to clear.",
      );
    }
  }

  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST" });
    window.location.href = "/login";
  }

  async function reloadApp(appId: string) {
    reloadState[appId] = "loading";
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(appId)}/reload`, { method: "POST" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `reload failed (${r.status})`);
      }
      reloadState[appId] = "ok";
      showSettingsToast(`${appId} reloaded`, "ok");
      setTimeout(() => {
        reloadState[appId] = "idle";
      }, 3000);
    } catch (err) {
      reloadState[appId] = "error";
      showSettingsToast(
        `reload failed: ${err instanceof Error ? err.message : String(err)}`,
        "err",
      );
      setTimeout(() => {
        reloadState[appId] = "idle";
      }, 3000);
    }
  }

  /** FIX_FORWARD 5.11: revoke one session. If it's the current one, the
   *  next request will fail auth and the browser redirects to /login.
   *
   *  Also forgets the matching client_devices row(s) so the storage
   *  telemetry doesn't orphan — per Seth's spec, "tracking the usage
   *  only makes sense for logged in sessions." Best-effort: matches
   *  by exact userAgent (or by deviceId for the current tab); a
   *  session with no matching device is a clean no-op on the forget
   *  leg. */
  async function revokeSession(id: string, isCurrent: boolean) {
    if (zeroOn) {
      const session = data.sessions.find((s) => s.id === id);
      if (session) {
        const device = deviceForSession({
          userAgent: session.userAgent,
          isCurrent,
        });
        if (device) zeroSync.forgetDevice(device.device_id);
      }
    }
    await fetch("/api/sessions/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (isCurrent) {
      window.location.href = "/login";
      return;
    }
    await invalidateAll();
  }

  async function revokeAll() {
    const ok = await confirmDialog({
      title: "Sign out everywhere?",
      description:
        "Sign out every session, including this one? You'll need to log back in.",
      confirmLabel: "Sign out everywhere",
      danger: true,
    });
    if (!ok) return;
    await fetch("/api/sessions/revoke-all", { method: "POST" });
    window.location.href = "/login";
  }

  function fmtTimestamp(ms: number): string {
    return new Date(ms).toLocaleString();
  }

  /** Phase 6: human-readable bytes (MB / GB) for storage indicators.
   *  Browser storage quotas live in the GB range; usage typically sits
   *  in MB. Both surfaces are coarse — no need for KB / B detail. */
  function fmtBytes(bytes: number | null | undefined): string {
    if (!Number.isFinite(bytes ?? NaN) || (bytes ?? 0) <= 0) return "—";
    const b = bytes as number;
    const gb = b / (1024 ** 3);
    if (gb >= 0.5) return `${gb.toFixed(2)} GB`;
    const mb = b / (1024 ** 2);
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    const kb = b / 1024;
    return `${kb.toFixed(1)} KB`;
  }

  function fmtStorageUsage(
    used: number | null | undefined,
    quota: number | null | undefined,
  ): string {
    const usedText = fmtBytes(used);
    if (!Number.isFinite(quota ?? NaN) || (quota ?? 0) <= 0) return usedText;
    return `${usedText} / ${fmtBytes(quota)}`;
  }

  /**
   * Match a BetterAuth session to a Zero `client_devices` row so we
   * can render storage telemetry inline with the session.
   *
   * Strategy:
   *   - Current session: use the tab's known `currentDeviceId` (most
   *     precise — no userAgent ambiguity).
   *   - Other sessions: best-effort match by exact userAgent string.
   *     If multiple devices share the same userAgent (same browser
   *     install, separate sign-ins), pick the most-recently-seen one.
   *   - No device row yet (a session whose tab hasn't reported storage
   *     stats in this account's history): return null and the row
   *     renders without the storage column.
   *
   * The "logged in sessions only" semantic from Seth's spec falls out
   * naturally: we iterate `data.sessions` and only sessions with a
   * device get the storage UI. Orphaned devices (no matching session)
   * are not rendered — they'll get cleaned up when the user revokes
   * the session or the `forgetDevice` mutator fires from a future
   * Settings affordance.
   */
  function deviceForSession(session: {
    userAgent: string | null;
    isCurrent: boolean;
  }): import("$lib/stores/zero.svelte").ZeroClientDeviceRow | null {
    // Revoked devices are tombstones — they shouldn't surface storage
    // info next to a session. Filter them out across both branches.
    if (session.isCurrent && zeroSync.currentDeviceId) {
      const cur = zeroSync.clientDevices.find(
        (d) => d.device_id === zeroSync.currentDeviceId,
      );
      return cur && cur.revoked_at === null ? cur : null;
    }
    const candidates = zeroSync.clientDevices.filter(
      (d) => d.user_agent === session.userAgent && d.revoked_at === null,
    );
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => b.last_seen_at - a.last_seen_at)[0]!;
  }

  function shortenUserAgent(ua: string | null): string {
    if (!ua) return "unknown client";
    // Pick out a recognizable browser/platform fragment. Full UA strings
    // are unreadable; we want a one-line glance affordance.
    if (/CriOS|Chrome\//.test(ua)) {
      if (/iPhone|iPad/.test(ua)) return "Chrome · iOS";
      if (/Android/.test(ua)) return "Chrome · Android";
      if (/Mac OS X/.test(ua)) return "Chrome · macOS";
      if (/Windows/.test(ua)) return "Chrome · Windows";
      return "Chrome";
    }
    if (/Firefox\//.test(ua)) return "Firefox";
    if (/Safari\//.test(ua)) {
      if (/iPhone|iPad/.test(ua)) return "Safari · iOS";
      return "Safari · macOS";
    }
    if (/curl\//.test(ua)) return "curl";
    return ua.slice(0, 60);
  }
</script>

<header class="page-head">
  <h1>Settings</h1>
  <p class="page-lead">Account, theme, and configuration.</p>
</header>

<div class="grid">
  <div class="card">
    <div class="card-header"><h2>Account</h2></div>
    <div class="row">
      <span class="row-label">Email</span>
      <span class="row-value">{data.user.email}</span>
    </div>
    <div class="row">
      <span class="row-label">Name</span>
      <span class="row-value">{data.user.name}</span>
    </div>
    <div class="row">
      <span class="row-label">Version</span>
      <span class="row-value">v{PUBLIC_APP_VERSION}</span>
    </div>
    <div class="actions">
      <button class="ghost" onclick={signOut}>Sign out</button>
    </div>
  </div>

  <CaptureKeys />

  <div class="card">
    <div class="card-header"><h2>Watchdog</h2></div>
    <p class="row-value">
      When an agent's worker process crashes mid-turn the watchdog can re-fork
      it automatically. Turn this off if you'd rather diagnose the cause by
      hand before letting Friday retry.
    </p>
    <div class="toggle-row">
      <Toggle
        bind:checked={watchdogRefork}
        label="Auto-refork crashed workers"
        disabled={savingSettings} />
    </div>
  </div>

  <div class="card models-card">
    <div class="card-header"><h2>Models</h2></div>
    <p class="row-value">
      Default model — used when no per-role or per-task override is set.
      Existing forked workers keep their current model until they exit.
    </p>
    <div class="actions">
      <select
        class="model-select"
        value={model}
        onchange={onModelChange}
        disabled={savingSettings}>
        {#each MODEL_OPTIONS as opt (opt.id)}
          <option value={opt.id}>{opt.label}</option>
        {/each}
      </select>
    </div>

    <div class="model-section">
      <div class="section-label">Per role</div>
      <p class="row-value">
        Route each agent role to its own model. Roles without an override
        use the default above.
      </p>
      <div class="model-grid">
        {#each ROLE_PICKERS as { role, label } (role)}
          <label class="model-pick">
            <span class="model-pick-label">{label}</span>
            <select
              class="model-select"
              value={roleModels[role] ?? ""}
              onchange={(e) => onRoleModelChange(role, e)}
              disabled={savingSettings}>
              <option value="">Use default</option>
              {#each MODEL_OPTIONS as opt (opt.id)}
                <option value={opt.id}>{opt.label}</option>
              {/each}
            </select>
          </label>
        {/each}
      </div>
    </div>

    <div class="model-section">
      <div class="section-label">Evolve tasks</div>
      <p class="row-value">
        Internal LLM passes in the evolve pipeline. Tasks without an
        override use the default above.
      </p>
      <div class="model-grid">
        {#each EVOLVE_PICKERS as { task, label } (task)}
          <label class="model-pick">
            <span class="model-pick-label">{label}</span>
            <select
              class="model-select"
              value={evolveModels[task] ?? ""}
              onchange={(e) => onEvolveModelChange(task, e)}
              disabled={savingSettings}>
              <option value="">Use default</option>
              {#each MODEL_OPTIONS as opt (opt.id)}
                <option value={opt.id}>{opt.label}</option>
              {/each}
            </select>
          </label>
        {/each}
      </div>
    </div>
  </div>

  <NotificationSettings />

  <div class="card">
    <div class="card-header"><h2>Apps</h2></div>
    <p class="row-value">
      Installed Friday Apps from <code>~/.friday/apps/</code>.
    </p>
    {#if apps.length === 0}
      <p class="row-value muted">No apps installed.</p>
    {:else}
      <ul class="apps-list">
        {#each apps as app (app.id)}
          <li class="app-row">
            <div class="app-head">
              <span class="app-id">{app.id}</span>
              <span class="app-version">v{app.version}</span>
              <span class="app-status app-status-{app.status}">
                {app.status}
              </span>
              <button
                class="ghost app-reload-btn"
                disabled={reloadState[app.id] === "loading"}
                onclick={() => reloadApp(app.id)}>
                {#if reloadState[app.id] === "loading"}
                  Reloading…
                {:else if reloadState[app.id] === "ok"}
                  Reloaded ✓
                {:else if reloadState[app.id] === "error"}
                  Failed — retry?
                {:else}
                  Reload
                {/if}
              </button>
            </div>
            <div class="app-name">{app.name}</div>
            {#if app.agents.length > 0}
              <div class="app-detail">
                <span class="muted">agents:</span>
                {app.agents.map((a) => a.name).join(", ")}
              </div>
            {/if}
            {#if app.schedules.length > 0}
              <div class="app-detail">
                <span class="muted">schedules:</span>
                {app.schedules
                  .map((s) => `${s.name} (${s.cron ?? "—"})`)
                  .join(", ")}
              </div>
            {/if}
            {#if app.mcpServers.length > 0}
              <div class="app-detail">
                <span class="muted">mcp:</span>
                {app.mcpServers.map((m) => m.name).join(", ")}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="card">
    <div class="card-header"><h2>Keep screen awake</h2></div>
    <p class="row-value">
      Hold a screen wake lock while any agent is working so your phone won't
      sleep mid-turn. Default on for mobile, off for desktop. iOS Safari only
      honours this while the tab is foreground — it can't wake a locked
      phone.
    </p>
    <div class="toggle-row">
      <Toggle
        bind:checked={wakeLockEnabled}
        label="Keep screen awake while agents work"
        disabled={!wakeLockState.supported} />
    </div>
    {#if !wakeLockState.supported}
      <p class="row-value muted">
        This browser doesn't support the Screen Wake Lock API.
      </p>
    {:else if wakeLockState.held}
      <p class="row-value muted">Wake lock is active right now.</p>
    {/if}
  </div>

  <div class="card">
    <div class="card-header"><h2>Rate limits</h2></div>
    <p class="row-value">
      Sign-in attempts and password resets are rate-limited per IP and per
      email. Clear every <code>auth:*</code> bucket if you're locked out and
      can't wait for the window to expire.
    </p>
    <div class="actions">
      <button class="ghost danger" onclick={resetAuthLimits}>
        Reset auth rate-limits
      </button>
    </div>
  </div>

  <div class="card appearance-card">
    <div class="card-header"><h2>Appearance</h2></div>
    <p class="row-value">
      Pick one palette for all conditions, or sync with your system's
      light/dark mode.
    </p>
    <div class="appearance-mode" role="radiogroup" aria-label="Appearance mode">
      <button
        type="button"
        class="appearance-mode-option"
        class:selected={theme.kind === "single"}
        aria-pressed={theme.kind === "single"}
        onclick={() => setThemeKind("single")}>
        Single theme
      </button>
      <button
        type="button"
        class="appearance-mode-option"
        class:selected={theme.kind === "sync"}
        aria-pressed={theme.kind === "sync"}
        onclick={() => setThemeKind("sync")}>
        <span class="appearance-mode-icon" aria-hidden="true">
          <Monitor size={14} strokeWidth={2} />
        </span>
        Sync with system
      </button>
    </div>

    {#if theme.kind === "single"}
      <div class="palette-section">
        <div class="section-label">Palette</div>
        <div class="palette-grid" role="radiogroup" aria-label="Single palette">
          {#each PALETTE_NAMES as p (p)}
            <button
              type="button"
              class="palette-card palette-{p}"
              class:selected={theme.config.picks.single === p}
              aria-pressed={theme.config.picks.single === p}
              onclick={() => setSinglePick(p)}>
              <PalettePreview palette={p} label={displayName(p)} />
            </button>
          {/each}
        </div>
        {#if !theme.config.picks.single}
          <p class="palette-default-note">
            Using default: {displayName(DEFAULTS[theme.systemMode])}
          </p>
        {/if}
      </div>
    {:else}
      <div class="palette-section">
        <div class="section-label">Light slot</div>
        <div class="palette-grid" role="radiogroup" aria-label="Light slot palette">
          {#each PALETTE_NAMES as p (p)}
            <button
              type="button"
              class="palette-card palette-{p}"
              class:selected={theme.config.picks.light === p}
              aria-pressed={theme.config.picks.light === p}
              onclick={() => setSlotPick("light", p)}>
              <PalettePreview palette={p} label={displayName(p)} />
            </button>
          {/each}
        </div>
        {#if !theme.config.picks.light}
          <p class="palette-default-note">
            Using default: {displayName(DEFAULTS.light)}
          </p>
        {/if}
      </div>
      <div class="palette-section">
        <div class="section-label">Dark slot</div>
        <div class="palette-grid" role="radiogroup" aria-label="Dark slot palette">
          {#each PALETTE_NAMES as p (p)}
            <button
              type="button"
              class="palette-card palette-{p}"
              class:selected={theme.config.picks.dark === p}
              aria-pressed={theme.config.picks.dark === p}
              onclick={() => setSlotPick("dark", p)}>
              <PalettePreview palette={p} label={displayName(p)} />
            </button>
          {/each}
        </div>
        {#if !theme.config.picks.dark}
          <p class="palette-default-note">
            Using default: {displayName(DEFAULTS.dark)}
          </p>
        {/if}
      </div>
    {/if}
  </div>

  <div class="card sessions-card">
    <div class="card-header"><h2>Active sessions</h2></div>
    <p class="row-value">
      Devices and browsers currently signed in to this account. Revoke one to force
      that session to re-authenticate. Storage usage is reported by the device
      when it has a live sync connection — sessions without a recent sync show
      no storage column.
    </p>
    {#if data.sessions.length === 0}
      <p class="row-value muted">No active sessions.</p>
    {:else}
      <ul class="session-list">
        {#each data.sessions as s (s.id)}
          {@const device = zeroOn ? deviceForSession(s) : null}
          <li class="session-row" class:current={s.isCurrent}>
            <div class="session-meta">
              <span class="session-client">{shortenUserAgent(s.userAgent)}</span>
              {#if s.ipAddress}
                <span class="session-ip">{s.ipAddress}</span>
              {/if}
              {#if s.isCurrent}
                <span class="session-current">this device</span>
              {/if}
            </div>
            {#if device}
              <div class="session-storage" aria-label="Storage usage">
                <span class="storage-usage">
                  {fmtStorageUsage(
                    device.storage_used_bytes,
                    device.storage_quota_bytes,
                  )}
                </span>
                <span class="session-last-seen">
                  Last sync {fmtTimestamp(device.last_seen_at)}
                </span>
              </div>
            {:else}
              <div class="session-storage muted" aria-label="No storage data">
                <span class="storage-usage muted">—</span>
              </div>
            {/if}
            <div class="session-times">
              <span>Signed in {fmtTimestamp(s.createdAt)}</span>
              <span class="session-expires">Expires {fmtTimestamp(s.expiresAt)}</span>
            </div>
            <button
              class="ghost session-revoke"
              onclick={() => revokeSession(s.id, s.isCurrent)}>
              Revoke
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="actions">
      <button class="ghost danger" onclick={revokeAll}>Sign out all sessions</button>
    </div>
  </div>

  <div class="card config-card">
    <div class="card-header"><h2>Configuration</h2></div>
    <p class="row-value">
      Edit <code>~/.friday/config.json</code> directly to add MCP servers or override defaults.
    </p>
    <p class="row-value">
      Edit <code>~/.friday/SOUL.md</code> to customize Friday's voice and identity.
    </p>
  </div>
</div>

{#if settingsToast}
  <div
    class="settings-toast toast-{settingsToast.kind}"
    role="status"
    aria-live="polite">
    {settingsToast.msg}
  </div>
{/if}

<style>
  .row {
    display: flex;
    justify-content: space-between;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 0.9rem;
  }
  .row:last-of-type { border-bottom: none; }
  .row-label {
    color: var(--text-tertiary);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .row-value { color: var(--text-primary); margin: 0.5rem 0; }
  .row-value.muted { color: var(--text-tertiary); }
  .row-value code {
    background: var(--bg-code);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
  .actions {
    margin-top: 1rem;
    display: flex;
    gap: 0.5rem;
  }
  .config-card { grid-column: 1 / -1; }
  .sessions-card { grid-column: 1 / -1; }
  .appearance-card { grid-column: 1 / -1; }
  .models-card { grid-column: 1 / -1; }
  .storage-usage { color: var(--text-primary); }

  /* FRI-124 Appearance card --------------------------------------- */
  .appearance-mode {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .appearance-mode-option {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.9rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
    color: var(--text-primary);
    cursor: pointer;
    font-size: 0.85rem;
    transition: all var(--transition-fast);
  }
  .appearance-mode-option.selected {
    border-color: var(--accent-primary);
    background: var(--accent-glow);
  }
  .appearance-mode-icon {
    display: inline-flex;
    align-items: center;
    color: var(--text-secondary);
  }
  .appearance-mode-option.selected .appearance-mode-icon {
    color: var(--accent-primary);
  }

  .palette-section {
    margin-top: 1.25rem;
  }
  .palette-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 0.75rem;
    margin-top: 0.5rem;
  }
  .palette-card {
    /* Each card wraps its preview in its own .palette-<name> class so
       the preview computes colors from THIS palette's tokens, not the
       currently-active one. AC #25. */
    appearance: none;
    border: 2px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg-card);
    padding: 0;
    cursor: pointer;
    overflow: hidden;
    transition:
      border-color var(--transition-fast),
      box-shadow var(--transition-fast);
    text-align: left;
    font: inherit;
  }
  .palette-card:hover {
    border-color: var(--border-primary);
    box-shadow: var(--shadow-sm);
  }
  .palette-card.selected {
    border-color: var(--accent-primary);
    box-shadow: 0 0 0 1px var(--accent-primary);
  }
  .palette-default-note {
    margin-top: 0.5rem;
    font-size: 0.78rem;
    color: var(--text-tertiary);
    font-style: italic;
  }

  .model-select {
    padding: 0.45rem 0.6rem;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    min-width: 280px;
  }
  .model-select:disabled { opacity: 0.6; }

  /* FRI-16 Models card: per-role + per-evolve-task override pickers. */
  .model-section {
    margin-top: 1.25rem;
  }
  .model-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0.75rem 1rem;
    margin-top: 0.5rem;
  }
  .model-pick {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .model-pick-label {
    color: var(--text-tertiary);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .model-pick .model-select {
    min-width: 0;
    width: 100%;
  }

  .toggle-row {
    display: inline-flex;
    align-items: center;
    margin-top: 0.75rem;
    font-size: 0.9rem;
    color: var(--text-primary);
  }

  .session-list {
    list-style: none;
    padding: 0;
    margin: 0.75rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .session-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    gap: 0.75rem 1rem;
    align-items: center;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
  }
  .session-storage {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.15rem;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: var(--font-mono);
    min-width: 8rem;
  }
  .session-storage.muted .storage-usage {
    color: var(--text-tertiary);
  }
  .session-last-seen {
    color: var(--text-tertiary);
  }
  .session-row.current {
    border-color: var(--accent-primary);
    background: var(--accent-glow);
  }
  .session-meta {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    min-width: 0;
  }
  .session-client {
    font-weight: 600;
    color: var(--text-primary);
    font-size: 0.85rem;
  }
  .session-ip {
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }
  .session-current {
    font-size: 0.65rem;
    color: var(--accent-primary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    background: var(--bg-card);
    padding: 0.1rem 0.4rem;
    border-radius: 99px;
  }
  .session-times {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.15rem;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: var(--font-mono);
  }
  .session-expires { color: var(--text-tertiary); }
  .session-revoke { font-size: 0.75rem; padding: 0.25rem 0.6rem; }

  @media (max-width: 640px) {
    .session-row {
      grid-template-columns: 1fr;
    }
    .session-times,
    .session-storage {
      align-items: flex-start;
    }
  }

  .settings-toast {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    padding: 0.6rem 0.9rem;
    border-radius: var(--radius-sm);
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    box-shadow: var(--shadow-md);
    font-size: 0.85rem;
    z-index: 50;
    max-width: min(420px, 90vw);
  }
  .settings-toast.toast-ok { border-color: var(--status-success); }
  .settings-toast.toast-err {
    border-color: var(--status-error);
    color: var(--status-error);
  }

  .apps-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .app-row {
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-surface, var(--bg-card));
  }
  .app-head {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .app-id {
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .app-version {
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }
  .app-status {
    font-size: 0.7rem;
    padding: 0.1rem 0.5rem;
    border-radius: 99px;
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    text-transform: lowercase;
  }
  .app-reload-btn {
    margin-left: auto;
    padding: 0.2rem 0.6rem;
    font-size: 0.75rem;
  }
  .app-status-installed { color: var(--status-success); }
  .app-status-orphaned { color: var(--text-tertiary); }
  .app-status-error { color: var(--status-error); }
  .app-name {
    margin-top: 0.2rem;
    color: var(--text-secondary);
    font-size: 0.85rem;
  }
  .app-detail {
    margin-top: 0.2rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .app-detail .muted {
    color: var(--text-tertiary);
    margin-right: 0.3rem;
  }
  .row-value.muted { color: var(--text-tertiary); }
  @media (max-width: 1023px) {
    .model-select {
      font-size: 16px;
    }
  }
</style>
