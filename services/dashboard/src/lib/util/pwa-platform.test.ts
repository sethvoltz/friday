/**
 * Tests for the iOS PWA external-link override.
 *
 * The dashboard vitest pool runs in plain node (no JSDOM), so the
 * click-handler test uses a structural fake event with a `.closest()`
 * method instead of real DOM nodes — parallels the AC#7 split in
 * `Markdown/markdown-links.test.ts` where `linkTargetAttrs` is tested
 * pure-function and the DOM-walking glue is left for component-level
 * coverage.
 */

import { describe, expect, it, vi } from "vitest";
import { decideExternalLinkIntercept, handleExternalLinkClick } from "./pwa-platform";

const ORIGIN = "https://friday.example";

describe("decideExternalLinkIntercept", () => {
  it("returns null outside iOS standalone PWA (desktop / Android / browser tab)", () => {
    expect(decideExternalLinkIntercept("https://github.com/o/r/pull/1", ORIGIN, false)).toBeNull();
  });

  it("intercepts cross-origin absolute https links in iOS standalone", () => {
    expect(decideExternalLinkIntercept("https://github.com/o/r/pull/1", ORIGIN, true)).toBe(
      "https://github.com/o/r/pull/1",
    );
  });

  it("intercepts protocol-relative // hrefs (resolved against the page origin's protocol)", () => {
    expect(decideExternalLinkIntercept("//github.com/x", ORIGIN, true)).toBe(
      "https://github.com/x",
    );
  });

  it("does NOT intercept same-origin absolute hrefs (internal links stay in the PWA)", () => {
    expect(
      decideExternalLinkIntercept("https://friday.example/tickets/123", ORIGIN, true),
    ).toBeNull();
  });

  it("does NOT intercept relative paths (SvelteKit handles those)", () => {
    expect(decideExternalLinkIntercept("/tickets/123", ORIGIN, true)).toBeNull();
    expect(decideExternalLinkIntercept("./foo", ORIGIN, true)).toBeNull();
    expect(decideExternalLinkIntercept("#hash", ORIGIN, true)).toBeNull();
  });

  it("handles mailto: / tel: by passing through (not absolute http(s), so default behavior)", () => {
    // These are absolute hrefs by the scheme test, and `new URL(...)` resolves
    // them to an opaque origin "null" that differs from pageOrigin — so they
    // *would* be intercepted and routed to `_system`. That matches the
    // intended behavior: iOS's system browser knows how to hand mailto/tel
    // off to Mail/Phone respectively, which is what we want.
    expect(decideExternalLinkIntercept("mailto:x@example.com", ORIGIN, true)).toBe(
      "mailto:x@example.com",
    );
    expect(decideExternalLinkIntercept("tel:+15551234", ORIGIN, true)).toBe("tel:+15551234");
  });

  it("returns null for malformed hrefs (defensive — never throws)", () => {
    // URL parsing of "https://" with no host throws — handler swallows and
    // falls through to default behavior rather than crash the click.
    expect(decideExternalLinkIntercept("https://", ORIGIN, true)).toBeNull();
  });
});

describe("handleExternalLinkClick", () => {
  /** Build a structural fake click event whose target.closest returns the
   *  given anchor (or null). */
  function makeEvent(anchorHref: string | null) {
    const anchor =
      anchorHref === null
        ? null
        : {
            getAttribute: (n: string) => (n === "href" ? anchorHref : null),
          };
    return {
      preventDefault: vi.fn(),
      target: { closest: vi.fn(() => anchor) },
    };
  }

  it("intercepts a cross-origin click in iOS standalone, preventing default and calling open()", () => {
    const event = makeEvent("https://github.com/o/r/pull/1");
    const open = vi.fn();
    const result = handleExternalLinkClick(event, {
      pageOrigin: ORIGIN,
      iosStandalone: true,
      open,
    });
    expect(result).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://github.com/o/r/pull/1");
  });

  it("does NOT intercept when not in iOS standalone (desktop / Android / browser tab keep default tab-open)", () => {
    const event = makeEvent("https://github.com/o/r/pull/1");
    const open = vi.fn();
    const result = handleExternalLinkClick(event, {
      pageOrigin: ORIGIN,
      iosStandalone: false,
      open,
    });
    expect(result).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("does NOT intercept same-origin clicks (internal SvelteKit nav stays put)", () => {
    const event = makeEvent("https://friday.example/tickets/123");
    const open = vi.fn();
    const result = handleExternalLinkClick(event, {
      pageOrigin: ORIGIN,
      iosStandalone: true,
      open,
    });
    expect(result).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("does NOT intercept clicks where there is no enclosing anchor", () => {
    const event = makeEvent(null);
    const open = vi.fn();
    const result = handleExternalLinkClick(event, {
      pageOrigin: ORIGIN,
      iosStandalone: true,
      open,
    });
    expect(result).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("does NOT intercept relative-href anchors (internal links keep default behavior)", () => {
    const event = makeEvent("/tickets/123");
    const open = vi.fn();
    const result = handleExternalLinkClick(event, {
      pageOrigin: ORIGIN,
      iosStandalone: true,
      open,
    });
    expect(result).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("survives a target with no closest() (degrades to false, no throw)", () => {
    const event = {
      preventDefault: vi.fn(),
      target: null,
    };
    const open = vi.fn();
    const result = handleExternalLinkClick(event, {
      pageOrigin: ORIGIN,
      iosStandalone: true,
      open,
    });
    expect(result).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
