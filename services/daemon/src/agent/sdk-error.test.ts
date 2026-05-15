import { describe, expect, it } from "vitest";
import { classifySdkError } from "./sdk-error.js";

// Headers-like helper that mirrors the SDK's actual `headers` object (it's
// a Fetch-API Headers instance with `.get(name)` semantics). Using a real
// Map subclass with `.get` lets the classifier exercise its preferred
// structural lookup path rather than the fallback object scan.
function fakeHeaders(entries: Record<string, string>): { get: (name: string) => string | null } {
  const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

// Mimics the SDK's `APIError.makeMessage` shape: `"${status} ${body}"`.
function makeApiError(status: number, body: string, opts: { requestId?: string; retryAfter?: string; retryAfterMs?: string } = {}): Error & {
  status: number;
  headers: { get: (name: string) => string | null };
  requestID?: string;
} {
  const headerEntries: Record<string, string> = {};
  if (opts.requestId) headerEntries["request-id"] = opts.requestId;
  if (opts.retryAfter) headerEntries["retry-after"] = opts.retryAfter;
  if (opts.retryAfterMs) headerEntries["retry-after-ms"] = opts.retryAfterMs;
  const e = Object.assign(new Error(`${status} ${body}`), {
    status,
    headers: fakeHeaders(headerEntries),
    requestID: opts.requestId,
  });
  return e;
}

describe("classifySdkError", () => {
  it("classifies 529 Overloaded with the captured user-visible body", () => {
    const e = makeApiError(
      529,
      `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check status.claude.com."}}`,
      { requestId: "req_overload_1" },
    );
    const r = classifySdkError(e);
    expect(r.code).toBe("overloaded");
    expect(r.httpStatus).toBe(529);
    expect(r.requestId).toBe("req_overload_1");
    expect(r.retryAfterSeconds).toBeUndefined();
    expect(r.headline).toContain("Anthropic temporarily overloaded");
    expect(r.rawMessage.startsWith("529 ")).toBe(true);
  });

  it("classifies 429 with retry-after header (seconds)", () => {
    const e = makeApiError(429, `{"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}`, {
      retryAfter: "30",
    });
    const r = classifySdkError(e);
    expect(r.code).toBe("rate_limited");
    expect(r.httpStatus).toBe(429);
    expect(r.retryAfterSeconds).toBe(30);
    expect(r.headline.startsWith("Rate limited")).toBe(true);
  });

  it("classifies 429 with retry-after-ms header", () => {
    const e = makeApiError(429, `{"error":{"message":"Slow down"}}`, { retryAfterMs: "12500" });
    const r = classifySdkError(e);
    expect(r.code).toBe("rate_limited");
    expect(r.retryAfterSeconds).toBe(13);
  });

  it("falls back to body-embedded retry hint when no headers present", () => {
    const e = new Error(`429 {"error":{"message":"Try again later","retry_after_seconds":45}}`);
    Object.assign(e, { status: 429 });
    const r = classifySdkError(e);
    expect(r.code).toBe("rate_limited");
    expect(r.retryAfterSeconds).toBe(45);
  });

  it("classifies 401 unauthorized", () => {
    const e = makeApiError(401, `{"error":{"message":"invalid x-api-key"}}`);
    const r = classifySdkError(e);
    expect(r.code).toBe("unauthorized");
    expect(r.httpStatus).toBe(401);
    expect(r.headline).toContain("Authentication failed");
    expect(r.headline).toContain("invalid x-api-key");
  });

  it("classifies 403 forbidden", () => {
    const e = makeApiError(403, `{"error":{"message":"feature unavailable"}}`);
    const r = classifySdkError(e);
    expect(r.code).toBe("forbidden");
    expect(r.headline).toContain("feature unavailable");
  });

  it("classifies 413 as context_too_long", () => {
    const e = makeApiError(413, `{"error":{"message":"prompt is too long"}}`);
    const r = classifySdkError(e);
    expect(r.code).toBe("context_too_long");
    expect(r.headline).toContain("prompt is too long");
  });

  it("classifies 500 as server_error", () => {
    const e = makeApiError(500, `{"error":{"message":"internal error"}}`);
    const r = classifySdkError(e);
    expect(r.code).toBe("server_error");
    expect(r.headline.startsWith("Anthropic server error")).toBe(true);
  });

  it("classifies 503 as service_unavailable", () => {
    const e = makeApiError(503, `{"error":{"message":"down for maintenance"}}`);
    const r = classifySdkError(e);
    expect(r.code).toBe("service_unavailable");
  });

  it("classifies AbortError as aborted", () => {
    const e = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const r = classifySdkError(e);
    expect(r.code).toBe("aborted");
    expect(r.httpStatus).toBeUndefined();
  });

  it("classifies APIUserAbortError name", () => {
    const e = Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
    expect(classifySdkError(e).code).toBe("aborted");
  });

  it("classifies ECONNRESET as network", () => {
    const e = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const r = classifySdkError(e);
    expect(r.code).toBe("network");
    expect(r.headline.startsWith("Network error")).toBe(true);
  });

  it("classifies ETIMEDOUT-bearing message as timeout (timeout regex wins before errno)", () => {
    const e = new Error("Request timed out after 60s");
    const r = classifySdkError(e);
    expect(r.code).toBe("timeout");
  });

  it("classifies ENOTFOUND from cause", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.anthropic.com"), {
      code: "ENOTFOUND",
    });
    const e = Object.assign(new Error("Connection error."), { cause });
    const r = classifySdkError(e);
    expect(r.code).toBe("network");
  });

  it("falls back to unknown for plain string", () => {
    const r = classifySdkError("something weird happened");
    expect(r.code).toBe("unknown");
    expect(r.rawMessage).toBe("something weird happened");
    expect(r.httpStatus).toBeUndefined();
  });

  it("handles malformed JSON tail without throwing", () => {
    const e = new Error("400 {not real json");
    Object.assign(e, { status: 400 });
    const r = classifySdkError(e);
    expect(r.code).toBe("bad_request");
    // No detail extractable; headline stays as the bare mapping.
    expect(r.headline).toBe("Bad request");
  });

  it("truncates very long unknown messages", () => {
    const long = "x".repeat(500);
    const r = classifySdkError(long);
    expect(r.code).toBe("unknown");
    expect(r.headline.length).toBeLessThan(260);
    expect(r.headline.endsWith("…")).toBe(true);
  });

  it("preserves rawMessage exactly", () => {
    const original = `529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`;
    const r = classifySdkError(new Error(original));
    expect(r.rawMessage).toBe(original);
  });

  it("recovers status from in-body 'status: 503' when prefix is absent", () => {
    const e = new Error("upstream returned status: 503 unavailable");
    const r = classifySdkError(e);
    expect(r.code).toBe("service_unavailable");
    expect(r.httpStatus).toBe(503);
  });
});
