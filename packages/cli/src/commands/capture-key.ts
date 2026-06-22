import { defineCommand } from "citty";
import pc from "picocolors";
import { confirm, isCancel } from "@clack/prompts";
import { DashboardClient } from "../lib/api.js";

/**
 * FRI-171 (ADR-047): `friday capture-key` — manage Capture keys for the
 * stateless `POST /api/capture` intake endpoint (the Apple Watch Shortcut /
 * quick-add path that has no session cookie).
 *
 * Capture-key issuance is a BetterAuth apiKey-plugin operation, and the plugin
 * lives in the DASHBOARD process — not the daemon. So this command talks to the
 * dashboard's loopback + daemon-secret-gated `/api/internal/capture-keys` route
 * (the CLI has no session cookie; it presents the shared daemon secret the same
 * way it reaches the daemon). Each key is scoped `capture:["write"]`.
 */

/** The management-safe view the dashboard returns (never the secret). */
export interface CaptureKeyView {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  enabled: boolean;
  createdAt: string;
  lastRequest: string | null;
  expiresAt: string | null;
}

/** Format an ISO timestamp for the list table; `—` for null. */
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

export const captureKeyCommand = defineCommand({
  meta: {
    name: "capture-key",
    description: "Manage Capture keys for the stateless /api/capture intake endpoint",
  },
  subCommands: {
    create: defineCommand({
      meta: { name: "create", description: "Mint a new Capture key (scope capture:write)" },
      args: {
        label: {
          type: "string",
          description: "A human label for the key (shown in the list)",
        },
      },
      async run({ args }) {
        const c = new DashboardClient();
        const label =
          typeof args.label === "string" && args.label.trim().length > 0
            ? args.label.trim()
            : "Capture key";
        const res = await c.post<{ key: string; view: CaptureKeyView }>(
          "/api/internal/capture-keys",
          { name: label },
        );
        console.log(pc.bold("Capture key created"));
        console.log(`  ${pc.dim("label")}   ${res.view.name ?? label}`);
        if (res.view.prefix) console.log(`  ${pc.dim("prefix")}  ${res.view.prefix}`);
        console.log("");
        console.log(pc.green(res.key));
        console.log("");
        console.log(pc.yellow("Store this key now — it will NOT be shown again."));
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List Capture keys (no secrets)" },
      async run() {
        const c = new DashboardClient();
        const res = await c.get<{ keys: CaptureKeyView[] }>("/api/internal/capture-keys");
        if (res.keys.length === 0) {
          console.log(pc.dim("no capture keys"));
          return;
        }
        // Header row, then one line per key: label, prefix, created, last-used, enabled.
        console.log(
          `  ${pc.dim("LABEL".padEnd(24))} ${pc.dim("PREFIX".padEnd(10))} ${pc.dim(
            "CREATED".padEnd(12),
          )} ${pc.dim("LAST-USED".padEnd(12))} ${pc.dim("ENABLED")}`,
        );
        for (const k of res.keys) {
          const enabled = k.enabled ? pc.green("yes") : pc.red("no");
          console.log(
            `  ${(k.name ?? "—").padEnd(24)} ${(k.prefix ?? "—").padEnd(10)} ${fmtDate(
              k.createdAt,
            ).padEnd(12)} ${fmtDate(k.lastRequest).padEnd(12)} ${enabled}`,
          );
        }
      },
    }),
    revoke: defineCommand({
      meta: {
        name: "revoke",
        description: "Revoke (disable) a Capture key by id or label",
      },
      args: {
        target: {
          type: "positional",
          required: true,
          description: "The key id or its label",
        },
        force: {
          type: "boolean",
          default: false,
          description: "Skip the confirmation prompt",
        },
      },
      async run({ args }) {
        const c = new DashboardClient();
        const target = String(args.target);
        // Resolve label → id (and confirm an id exists) via the list.
        const { keys } = await c.get<{ keys: CaptureKeyView[] }>("/api/internal/capture-keys");
        const byId = keys.find((k) => k.id === target);
        const byLabel = keys.filter((k) => k.name === target);
        let key: CaptureKeyView;
        if (byId) {
          key = byId;
        } else if (byLabel.length === 1) {
          key = byLabel[0]!;
        } else if (byLabel.length > 1) {
          console.error(
            pc.red(
              `multiple keys labeled "${target}" — revoke by id instead (run \`friday capture-key list\`)`,
            ),
          );
          process.exit(1);
        } else {
          console.error(pc.red(`no capture key matches "${target}"`));
          process.exit(1);
        }

        if (!args.force) {
          const ok = await confirm({
            message: pc.yellow(
              `Revoke capture key "${key.name ?? key.id}" (${key.prefix ?? key.id})? It will stop working immediately.`,
            ),
            initialValue: false,
          });
          if (isCancel(ok) || !ok) {
            console.log(pc.dim("aborted"));
            return;
          }
        }
        await c.del<{ ok: boolean }>(`/api/internal/capture-keys?id=${encodeURIComponent(key.id)}`);
        console.log(pc.green(`revoked ${key.name ?? key.id}`));
      },
    }),
  },
});
