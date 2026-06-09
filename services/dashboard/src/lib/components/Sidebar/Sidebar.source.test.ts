/**
 * Source-level invariants for the Sidebar click-bleed-through fix
 * (FRI-126). These pin the CSS/markup contract the Playwright geometry
 * suite (`e2e/sidebar-click-targets.spec.ts`) depends on, at a layer
 * that runs in the fast `pnpm test` unit suite — so a regression that
 * reintroduces the bug fails before the slow browser suite even boots.
 *
 * Strategy mirrors `foucScript.test.ts`: read the component source and
 * assert on the exact declarations. We deliberately assert on the
 * `.expand-slot { ... }`, `.row-main { ... }`, and `.expand-btn { ... }`
 * *base* selector blocks (not the whole file) so the assertions can't
 * be satisfied by an unrelated occurrence elsewhere (e.g. the existing
 * `touch-action: manipulation` on the mobile `.trigger`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "Sidebar.svelte"), "utf8");

/**
 * Extract the body of a top-level CSS rule whose selector list ends with
 * exactly `selector` followed by ` {`. Matches balanced braces (the
 * Sidebar's rule bodies contain no nested braces, so a non-greedy run to
 * the first `}` is sufficient and unambiguous).
 */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anchor on a line that is exactly the selector + " {" so we don't
  // accidentally match `.row-main` inside `.row.pinned .row-main { ... }`.
  const re = new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "m");
  const m = SRC.match(re);
  if (!m) throw new Error(`could not find CSS rule for selector \`${selector}\``);
  return m[2]!;
}

describe("Sidebar.svelte source invariants (FRI-126)", () => {
  it("AC5: the base .expand-slot block no longer declares pointer-events: none", () => {
    const body = ruleBody(".expand-slot");
    expect(body).not.toMatch(/pointer-events\s*:\s*none/);
    // Positive: the slot is now a real click target (cursor reflects it).
    expect(body).toMatch(/cursor\s*:\s*pointer/);
  });

  it("AC6: .row-main declares touch-action: manipulation", () => {
    const body = ruleBody(".row-main");
    expect(body).toMatch(/touch-action\s*:\s*manipulation/);
  });

  it("AC6: .expand-btn declares touch-action: manipulation", () => {
    const body = ruleBody(".expand-btn");
    expect(body).toMatch(/touch-action\s*:\s*manipulation/);
  });

  it("AC10: the .row element carries data-agent={a.name} for selector resolvability", () => {
    // The agentRow snippet's opening <div class="row" ... > must include
    // the data-agent binding so the Playwright `.row[data-agent=...]`
    // selectors resolve.
    expect(SRC).toMatch(/<div\s+class="row"\s+data-agent=\{a\.name\}/);
  });

  it("the .expand-slot wrapper forwards clicks to toggleHistory", () => {
    // Prong A: the slot itself (not just the inner button) dispatches the
    // toggle, so a tap in the slot's non-button area no longer falls
    // through to .row-main.
    expect(SRC).toMatch(/class="expand-slot"[\s\S]*?onclick=\{\(\) => toggleHistory\(a\.name\)\}/);
  });

  it("the inner .expand-btn stops propagation so a direct glyph click toggles exactly once", () => {
    // Without stopPropagation, a click on the button would bubble
    // button → slot and fire toggleHistory twice.
    expect(SRC).toMatch(
      /class="expand-btn"[\s\S]*?onclick=\{\(e\) => \{ e\.stopPropagation\(\); void toggleHistory\(a\.name\); \}\}/,
    );
  });

  it("Prong B1: .row-main records the pointerdown row and guards focus clicks", () => {
    // The focus handler must be the guarded variant (not the raw
    // focusAgent), and a pointerdown handler must record the row so the
    // guard can detect a mid-gesture retarget.
    expect(SRC).toMatch(/onpointerdown=\{\(\) => recordRowPointerDown\(a\.name\)\}/);
    expect(SRC).toMatch(/onclick=\{\(e\) => focusAgentGuarded\(e, a\.name, a\.type\)\}/);
    // The guard swallows a click that surfaced on a row it didn't start on.
    expect(SRC).toMatch(/pointerDownRow !== null && pointerDownRow !== name/);
    expect(SRC).toMatch(/e\.preventDefault\(\)/);
  });

  it("FRI-162 AC1: loadPastSessions resets the error flag, delegates to the retry helper, and maps the result via applyLoadResult", () => {
    // The wrapper must clear the per-agent error flag at the start of a
    // load and route the result through applyLoadResult — it must NOT
    // re-implement the success-only `if (r.ok)` swallow that was the bug.
    expect(SRC).toMatch(/chat\.sidebarSessionsError\[name\]\s*=\s*false/);
    expect(SRC).toMatch(/await loadPastSessionsWithRetry\(name\)/);
    expect(SRC).toMatch(/applyLoadResult\(chat, name, result\)/);
    // The old swallow path is gone: no bare `if (r.ok)` cache in the
    // component anymore (that logic moved into the helper).
    expect(SRC).not.toMatch(/if\s*\(\s*r\.ok\s*\)/);
  });

  it("FRI-162 AC3: the history submenu renders a distinct error + Retry affordance gated on sidebarSessionsError, not 'No past sessions'", () => {
    // The error branch must sit on sidebarSessionsError[a.name] and render
    // its own block (role=alert), distinct from the "No past sessions"
    // empty branch.
    expect(SRC).toMatch(/\{:else if chat\.sidebarSessionsError\[a\.name\]\}/);
    expect(SRC).toMatch(/class="history-error"\s+role="alert"/);
    // The empty branch still exists and is a SEPARATE branch — a failure
    // must not fall through to it.
    expect(SRC).toMatch(/No past sessions/);
  });

  it("FRI-162 AC3: clicking Retry re-issues loadPastSessions for the row's agent", () => {
    expect(SRC).toMatch(/class="retry-btn"[\s\S]*?onclick=\{\(\) => loadPastSessions\(a\.name\)\}/);
  });

  it("FRI-162: the route-driven fetch effect bails on a settled error state so a persistent failure can't spin loadPastSessions", () => {
    // The route effect's finally-flips-loading-false re-runs the effect; on a
    // persistently-down daemon with the route pinned to a past session,
    // without an error-flag guard it would re-fire the full bounded retry
    // indefinitely and never settle into the stable Retry affordance. The
    // guard must sit AFTER the loading guard and BEFORE the loadPastSessions
    // call, keyed on routeAgent.
    expect(SRC).toMatch(
      /if \(chat\.sidebarLoadingSessions\[routeAgent\]\) return;[\s\S]*?if \(chat\.sidebarSessionsError\[routeAgent\]\) return;[\s\S]*?void loadPastSessions\(routeAgent\)/,
    );
  });

  it("AC11: no require() or dynamic import() in the changed component", () => {
    // CLAUDE.md "Static imports only" — guard against a regression that
    // sneaks a dynamic import into the click-guard logic.
    expect(SRC).not.toMatch(/\brequire\s*\(/);
    expect(SRC).not.toMatch(/\bimport\s*\(/);
  });
});
