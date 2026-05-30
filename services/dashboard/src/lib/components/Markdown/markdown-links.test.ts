/**
 * Renderer-side regression guards for FRI-131 (auto-linked PR/issue refs).
 *
 * The pr-links protocol teaches agents to emit a full markdown link
 * (`[#123](https://github.com/o/r/pull/123)`) instead of bare `#123`. These
 * tests pin the two halves of the render path the dashboard relies on:
 *
 *  - AC#6: `marked` + `isomorphic-dompurify` (configured exactly as
 *    `Markdown.svelte` does) turn that markdown into a clickable `<a>` with the
 *    GitHub href intact through sanitization.
 *  - AC#7: `processLinks`' absolute-href branch — extracted into the pure
 *    `linkTargetAttrs` helper so it is testable in the dashboard's DOM-less
 *    node vitest pool — tags the GitHub href with `target="_blank"` +
 *    `rel="noopener noreferrer"`, and leaves relative/internal links alone.
 *
 * Note on the AC#6 payload: AC#6 pins the reviewer-re-proven §3 output via the
 * regex `>#123</a>`, i.e. the anchor TEXT must be exactly `#123`. That is the
 * output the reviewer ran in §3 from the source `PR [#123](…)` (only `#123`
 * inside the brackets). The literal payload string quoted in the AC body
 * (`[PR #123](…)`) would instead make the anchor text `PR #123` and could not
 * satisfy that regex — an internal inconsistency in the AC. We follow the
 * reviewer-proven output (the load-bearing regex) and use the §3 payload form.
 */

import { marked } from "marked";
import DOMPurify from "isomorphic-dompurify";
import { describe, expect, it } from "vitest";
import { linkTargetAttrs, isAbsoluteHref, ABSOLUTE_HREF } from "./link-target";

/**
 * Render exactly as Markdown.svelte does (parse opts + DOMPurify profiles).
 * `.trim()` drops the trailing newline `marked` appends after a block — it is
 * cosmetic whitespace the renderer ignores, so the exact-string assertions
 * compare the load-bearing markup.
 */
function render(src: string): string {
  const raw = marked.parse(src, { gfm: true, breaks: true, async: false }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true, mathMl: true } }).trim();
}

describe("AC#6 — markdown PR/issue link survives marked + DOMPurify as a clickable anchor", () => {
  it("renders a PR link with the exact GitHub href and #123 anchor text", () => {
    const html = render("PR [#123](https://github.com/o/r/pull/123) is ready");
    // Pin the exact reviewer-proven §3 output.
    expect(html).toBe('<p>PR <a href="https://github.com/o/r/pull/123">#123</a> is ready</p>');
    // And the load-bearing AC#6 regex (anchor text == #123, href intact).
    expect(html).toMatch(/<a [^>]*href="https:\/\/github\.com\/o\/r\/pull\/123"[^>]*>#123<\/a>/);
  });

  it("renders an issue link with the exact GitHub issues href and #88 anchor text", () => {
    const html = render("Fixed in [#88](https://github.com/acme/widgets/issues/88).");
    expect(html).toBe(
      '<p>Fixed in <a href="https://github.com/acme/widgets/issues/88">#88</a>.</p>',
    );
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/github\.com\/acme\/widgets\/issues\/88"[^>]*>#88<\/a>/,
    );
  });

  it("does NOT auto-link a bare #123 (proves the prompt-only step is necessary)", () => {
    // GFM autolinks a bare full URL but leaves `#123` as plain text.
    const html = render("PR #123 ready, see https://x.com");
    expect(html).not.toMatch(/<a [^>]*>#123<\/a>/);
    expect(html).toContain("PR #123 ready");
  });
});

describe("AC#7 — processLinks absolute-href branch (linkTargetAttrs) opens external links in a new tab", () => {
  it("tags an absolute GitHub PR href with target=_blank and rel=noopener noreferrer", () => {
    const attrs = linkTargetAttrs("https://github.com/o/r/pull/123");
    expect(attrs).toEqual({ target: "_blank", rel: "noopener noreferrer" });
  });

  it("treats protocol-relative // hrefs as absolute (new tab)", () => {
    expect(linkTargetAttrs("//example.com/x")).toEqual({
      target: "_blank",
      rel: "noopener noreferrer",
    });
  });

  it("leaves relative / internal hrefs in the same tab (null = no override)", () => {
    expect(linkTargetAttrs("/tickets/123")).toBeNull();
    expect(linkTargetAttrs("./foo")).toBeNull();
    expect(linkTargetAttrs("#hash")).toBeNull();
  });

  it("the GitHub href emitted by the AC#6 render path matches ABSOLUTE_HREF", () => {
    // Ties the two ACs together: the href DOMPurify let through (AC#6) is the
    // one processLinks will tag for a new tab (AC#7).
    const html = render("PR [#123](https://github.com/o/r/pull/123) is ready");
    const href = html.match(/href="([^"]+)"/)?.[1];
    expect(href).toBe("https://github.com/o/r/pull/123");
    expect(isAbsoluteHref(href!)).toBe(true);
    expect(ABSOLUTE_HREF.test(href!)).toBe(true);
  });
});
