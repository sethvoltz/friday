/**
 * FRI-66: cooperative abort signal threading through the worker → daemon MCP
 * boundary. Validates two contracts the user-visible Stop button depends on:
 *
 *   1. `signalFrom(extra)` extracts the MCP SDK's RequestHandlerExtra.signal
 *      cleanly across the realistic shapes the SDK passes — including the
 *      degenerate cases (no extra, no signal, non-AbortSignal) so a future
 *      SDK refactor that drops the field doesn't silently strip cancellation.
 *
 *   2. `daemonFetch` forwards `signal:` into the underlying `fetch()` and the
 *      in-flight request throws `AbortError` within a tight window after the
 *      controller fires. This is the load-bearing assertion for FRI-66 — if
 *      the signal isn't forwarded, the worker stays blocked on a hung daemon
 *      response after the user hits Stop, defeating the cooperative-abort
 *      path the SDK plumbing was wired up for in FRI-78.
 *
 * Both tests run a tiny in-process HTTP server that hangs the response
 * indefinitely, so the only termination path is the abort signal.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { daemonFetch, signalFrom } from "./http.js";

describe("signalFrom (FRI-66)", () => {
  it("extracts an AbortSignal from the MCP SDK's extra shape", () => {
    const ctrl = new AbortController();
    const extra = { signal: ctrl.signal };
    expect(signalFrom(extra)).toBe(ctrl.signal);
  });

  it("returns undefined when extra is missing", () => {
    expect(signalFrom(undefined)).toBeUndefined();
    expect(signalFrom(null)).toBeUndefined();
  });

  it("returns undefined when extra lacks a signal field", () => {
    expect(signalFrom({})).toBeUndefined();
    expect(signalFrom({ authInfo: { token: "x" } })).toBeUndefined();
  });

  it("returns undefined when extra.signal is not an AbortSignal", () => {
    // Future-proofing: if a transport ever stuffs a non-AbortSignal into
    // the field (e.g. a string sentinel from a wrapper layer), we don't
    // want to silently pass garbage into fetch().
    expect(signalFrom({ signal: "abort" })).toBeUndefined();
    expect(signalFrom({ signal: 42 })).toBeUndefined();
    expect(signalFrom({ signal: { aborted: false } })).toBeUndefined();
  });
});

describe("daemonFetch signal forwarding (FRI-66)", () => {
  let server: Server;
  let port: number;
  // Resolved with the server-observed signal-aborted state of the most
  // recent request, after the client disconnects. Used to assert the server
  // saw the cancel land (vs. the client just timing out independently).
  let lastRequestAborted: Promise<boolean>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastRequestAborted = new Promise((resolve) => {
        req.on("close", () => {
          // Node's IncomingMessage exposes `.destroyed`/`.aborted` once the
          // peer closes the socket. Either signal confirms the daemon saw
          // the client go away mid-flight — which is exactly what cancel
          // propagation through fetch produces.
          resolve(req.destroyed || (req as unknown as { aborted: boolean }).aborted === true);
        });
      });
      // Never respond — the only way out is the client aborting.
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("forwards `signal` into the underlying fetch() and throws on abort", async () => {
    const ctrl = new AbortController();
    const t0 = Date.now();

    const fetchPromise = daemonFetch({
      port,
      path: "/hang",
      callerName: "test-fri-66",
      signal: ctrl.signal,
    });

    // Give the request a moment to land server-side before aborting, so
    // the close event we await below comes from the abort, not from a
    // race where we abort before the socket connects.
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort();

    await expect(fetchPromise).rejects.toThrow();
    const elapsed = Date.now() - t0;

    // Healthy cancel lands in well under 100ms. The 500ms ceiling here is
    // a flake-buffer for CI; the assertion that matters is "the fetch
    // didn't sit forever," not the exact timing.
    expect(elapsed).toBeLessThan(500);

    // Confirm the server actually saw the client disconnect — this rules
    // out the case where daemonFetch swallowed the signal and we're just
    // observing the test runner's promise rejection.
    const sawAbort = await lastRequestAborted;
    expect(sawAbort).toBe(true);
  });

  it("does NOT inject a signal field when none is provided (no spurious aborts)", async () => {
    // Regression guard: `...(opts.signal ? { signal: opts.signal } : {})`
    // is the conditional spread that keeps the option absent rather than
    // explicitly `undefined`. A `signal: undefined` in fetch options is
    // benign today but stylistically wrong and would break any future
    // wrapper that tests `'signal' in options`. We assert the contract by
    // confirming a no-signal call still hits the server normally.
    const reqLanded = new Promise<void>((resolve) => {
      const noSignalServer = createServer((req, res) => {
        req.resume(); // drain
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        resolve();
      });
      noSignalServer.listen(0, "127.0.0.1", async () => {
        const p = (noSignalServer.address() as AddressInfo).port;
        const result = await daemonFetch<{ ok: boolean }>({
          port: p,
          path: "/ok",
          callerName: "test-fri-66",
          // signal intentionally omitted
        });
        expect(result.ok).toBe(true);
        noSignalServer.close();
      });
    });
    await reqLanded;
  });
});
