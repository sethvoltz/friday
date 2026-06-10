import pc from "picocolors";

/** One secret's display-relevant fields, decoupled from the vault internals so
 *  the renderer stays pure and testable. `scope` is the ordered list of scope
 *  tags (`daemon`, `app=<id>`, `agents=<list>`); empty for an unscoped key. */
export interface SecretListRow {
  name: string;
  mode: string;
  scope: string[];
  broken: boolean;
}

/** The subset of `SecretMeta` the list view needs. Kept structural so this
 *  module stays dependency-light (only `picocolors`); `SecretMeta[]` from
 *  `@friday/shared` is assignable. */
export interface SecretMetaInput {
  name: string;
  mode: string;
  app?: string;
  daemon?: boolean;
  agents?: string[];
}

/** Mirror of `vaultKeyForMeta` in `@friday/shared` — the vault key a meta entry
 *  maps to. Inlined to avoid pulling the vault module into this pure formatter. */
const vaultKeyFor = (s: SecretMetaInput): string => (s.app ? `apps/${s.app}/${s.name}` : s.name);

/**
 * Project vault metadata into renderable rows, computing per-row `broken`
 * state honestly:
 *
 * - A row is broken **only** when the vault is unlocked AND this specific key
 *   has no vault value (an orphaned meta entry). One orphan must not smear
 *   `broken` across every healthy row.
 * - When the vault is locked, `vaultKeys` is empty and brokenness is
 *   unverifiable, so nothing is flagged (avoids a wall of false positives).
 *
 * Orphaned *vault* values (a value with no meta) aren't representable as rows
 * here; `friday doctor`'s bijection check is the surface for that.
 */
export function buildSecretRows(
  secrets: SecretMetaInput[],
  vaultKeys: Set<string>,
  opts: { unlocked: boolean; app?: string },
): SecretListRow[] {
  return secrets
    .filter((s) => !opts.app || s.app === opts.app)
    .map((s) => ({
      name: s.name,
      mode: s.mode,
      scope: [
        s.daemon ? "daemon" : null,
        s.app ? `app=${s.app}` : null,
        s.agents?.length ? `agents=${s.agents.join(",")}` : null,
      ].filter((x): x is string => Boolean(x)),
      broken: opts.unlocked && !vaultKeys.has(vaultKeyFor(s)),
    }));
}

function colorScopePart(part: string): string {
  if (part === "daemon") return pc.blue(part);
  if (part.startsWith("app=")) return pc.magenta(part);
  if (part.startsWith("agents=")) return pc.cyan(part);
  return part;
}

const padEnd = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));

/**
 * Render the `friday secrets list` table.
 *
 * - **Interactive (`tty: true`)** — aligned columns with a dim header and
 *   per-field color. Column widths are computed from the *plain* text, so the
 *   alignment holds whether or not `picocolors` emits escape codes (it stays
 *   inert when stdout isn't a TTY / under `NO_COLOR`).
 * - **Non-interactive (`tty: false`)** — one tab-separated record per row, no
 *   header, no indent, stable four-column shape (`name⇥mode⇥scope⇥status`) so
 *   `cut`/`awk` and the like can consume it. `scope` parts join with `,`.
 */
export function renderSecretsList(rows: SecretListRow[], opts: { tty: boolean }): string[] {
  if (rows.length === 0) {
    return opts.tty ? [pc.dim("  no secrets stored")] : [];
  }

  if (!opts.tty) {
    return rows.map((r) =>
      [r.name, r.mode, r.scope.join(","), r.broken ? "broken" : "ok"].join("\t"),
    );
  }

  const plainScope = (r: SecretListRow): string => (r.scope.length ? r.scope.join(" ") : "—");
  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const modeW = Math.max(4, ...rows.map((r) => r.mode.length));
  const scopeW = Math.max(5, ...rows.map((r) => plainScope(r).length));

  const rtrim = (s: string): string => s.replace(/\s+$/u, "");
  const lines: string[] = [];
  lines.push(
    rtrim(
      "  " +
        pc.bold(pc.dim(padEnd("NAME", nameW))) +
        "  " +
        pc.bold(pc.dim(padEnd("MODE", modeW))) +
        "  " +
        pc.bold(pc.dim("SCOPE")),
    ),
  );
  for (const r of rows) {
    const name = pc.bold(padEnd(r.name, nameW));
    const mode = (r.mode === "on-demand" ? pc.yellow : pc.green)(padEnd(r.mode, modeW));
    const ps = plainScope(r);
    const coloredScope = r.scope.length ? r.scope.map(colorScopePart).join(" ") : pc.dim("—");
    const scopeCell = coloredScope + " ".repeat(Math.max(0, scopeW - ps.length));
    const status = r.broken ? "  " + pc.red(pc.bold("broken")) : "";
    lines.push(rtrim("  " + name + "  " + mode + "  " + scopeCell + status));
  }
  return lines;
}
