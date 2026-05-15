/**
 * Map a thrown SDK error into a structured, user-presentable shape.
 *
 * The Anthropic SDK throws classed errors (`APIError`, `RateLimitError`,
 * `APIConnectionError`, `APIUserAbortError`, …) whose `message` is formatted
 * `"${status} ${body}"`. They also carry `status`, `headers`, `requestID`,
 * `error.type` when available. This classifier reads those fields when
 * present and falls back to regex-parsing the message string — the SDK's
 * error wrapping changes between minor versions, so structural lookups are
 * a hint, not a guarantee.
 *
 * Output is consumed by the worker IPC `error` event and persisted as a
 * `kind: "error"` block. Headlines are short user-facing strings; raw text
 * lives in `rawMessage` for the bubble's "Details" expansion.
 */

export interface ClassifiedError {
  /** Stable machine code: `overloaded`, `rate_limited`, `unauthorized`, … */
  code: string;
  /** Short user-facing message rendered as the error bubble's headline. */
  headline: string;
  /** HTTP status when the SDK supplied one. */
  httpStatus?: number;
  /** Seconds to wait before retrying (from retry-after header / body). */
  retryAfterSeconds?: number;
  /** SDK request id when present — useful for support tickets. */
  requestId?: string;
  /** Original error message string. Always populated. */
  rawMessage: string;
}

const HEADLINE: Record<string, string> = {
  bad_request: "Bad request",
  unauthorized: "Authentication failed — check your Anthropic API key",
  forbidden: "Permission denied",
  not_found: "Not found",
  context_too_long: "Conversation too long for this model",
  unprocessable: "Request rejected as invalid",
  rate_limited: "Rate limited",
  server_error: "Anthropic server error",
  service_unavailable: "Anthropic temporarily unavailable",
  overloaded: "Anthropic temporarily overloaded — usually clears in a moment",
  network: "Network error reaching Anthropic",
  timeout: "Request to Anthropic timed out",
  aborted: "Stopped",
  unknown: "Something went wrong",
};

function codeForStatus(status: number): string {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 413) return "context_too_long";
  if (status === 422) return "unprocessable";
  if (status === 429) return "rate_limited";
  if (status === 529) return "overloaded";
  if (status === 503) return "service_unavailable";
  if (status >= 500) return "server_error";
  return "unknown";
}

function readNumber(obj: unknown, key: string): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function readString(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Pull `retry-after` / `retry-after-ms` from a Headers-like or plain-object
 * carrier. Returns whole seconds, rounded up. Returns undefined when no
 * usable value is found.
 */
function retryAfterFromHeaders(headers: unknown): number | undefined {
  if (!headers) return undefined;
  let raw: string | number | undefined;
  let rawMs: string | number | undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const get = (headers as { get: (name: string) => string | null }).get;
    raw = get.call(headers, "retry-after") ?? undefined;
    rawMs = get.call(headers, "retry-after-ms") ?? undefined;
  } else if (typeof headers === "object") {
    const h = headers as Record<string, unknown>;
    const find = (name: string): string | undefined => {
      for (const k of Object.keys(h)) {
        if (k.toLowerCase() === name) {
          const v = h[k];
          return typeof v === "string" ? v : undefined;
        }
      }
      return undefined;
    };
    raw = find("retry-after");
    rawMs = find("retry-after-ms");
  }
  if (rawMs !== undefined) {
    const n = typeof rawMs === "number" ? rawMs : Number.parseFloat(String(rawMs));
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n / 1000);
  }
  if (raw !== undefined) {
    // Could be seconds (integer) or HTTP-date.
    const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
    const ts = Date.parse(String(raw));
    if (Number.isFinite(ts)) {
      const sec = Math.ceil((ts - Date.now()) / 1000);
      return sec > 0 ? sec : undefined;
    }
  }
  return undefined;
}

/**
 * Last-resort body scan for a retry hint. The SDK occasionally embeds
 * `"retry after 30 seconds"` or a JSON `{retry_after_seconds: 30}` blob in
 * the rendered error message even when no Headers object is reachable.
 */
function retryAfterFromBody(raw: string): number | undefined {
  const json = raw.match(/\{[\s\S]*\}\s*$/);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]);
      const candidate =
        readNumber(parsed, "retry_after_seconds") ??
        readNumber(parsed, "retryAfterSeconds") ??
        readNumber((parsed as { error?: unknown })?.error, "retry_after_seconds");
      if (candidate !== undefined && candidate >= 0) return Math.ceil(candidate);
    } catch {
      // fall through to regex
    }
  }
  const match = raw.match(/retry[\s_-]?after[^0-9]{0,10}(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms|milli)?/i);
  if (match) {
    const n = Number.parseFloat(match[1]);
    if (Number.isFinite(n) && n >= 0) {
      const unit = match[2]?.toLowerCase();
      if (unit && unit.startsWith("ms")) return Math.ceil(n / 1000);
      return Math.ceil(n);
    }
  }
  return undefined;
}

function requestIdFromObj(err: unknown, headers: unknown): string | undefined {
  const direct = readString(err, "requestID") ?? readString(err, "request_id");
  if (direct) return direct;
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    const v = (headers as { get: (n: string) => string | null }).get("request-id");
    if (v) return v;
  }
  return undefined;
}

function isAbort(err: unknown, raw: string): boolean {
  if (err && typeof err === "object") {
    const name = readString(err, "name");
    if (name === "AbortError" || name === "APIUserAbortError") return true;
  }
  return /\baborted\b|FetchRequestCanceledException/i.test(raw);
}

function networkErrnoCode(err: unknown, raw: string): string | undefined {
  const codeProp = readString(err, "code");
  if (codeProp && /^E[A-Z]+$/.test(codeProp)) return codeProp;
  const cause = (err as { cause?: unknown })?.cause;
  if (cause) {
    const causeCode = readString(cause, "code");
    if (causeCode && /^E[A-Z]+$/.test(causeCode)) return causeCode;
  }
  const m = raw.match(/\b(ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b/);
  return m ? m[1] : undefined;
}

export function classifySdkError(err: unknown): ClassifiedError {
  const rawMessage = err instanceof Error ? err.message : String(err ?? "");

  if (isAbort(err, rawMessage)) {
    return { code: "aborted", headline: HEADLINE.aborted, rawMessage };
  }

  // Status from object property first; then from "${status} ${body}" prefix.
  let httpStatus = readNumber(err, "status");
  if (httpStatus === undefined) {
    const m = rawMessage.match(/^(\d{3})\b/);
    if (m) httpStatus = Number.parseInt(m[1], 10);
  }
  if (httpStatus === undefined) {
    // Older SDK versions surface status only inside the message body.
    const m = rawMessage.match(/\bstatus\s*[:=]\s*(\d{3})\b/i);
    if (m) httpStatus = Number.parseInt(m[1], 10);
  }

  // Network / timeout — map before the unknown fallback.
  if (httpStatus === undefined) {
    if (/timed?[\s-]?out|ETIMEDOUT/i.test(rawMessage)) {
      return { code: "timeout", headline: HEADLINE.timeout, rawMessage };
    }
    const errno = networkErrnoCode(err, rawMessage);
    if (errno) {
      return { code: "network", headline: HEADLINE.network, rawMessage };
    }
    // Connection error class without an explicit errno.
    const ctor = err && typeof err === "object" ? (err as { constructor?: { name?: string } }).constructor?.name : undefined;
    if (ctor && /Connection/i.test(ctor)) {
      return { code: "network", headline: HEADLINE.network, rawMessage };
    }
  }

  if (httpStatus !== undefined) {
    const code = codeForStatus(httpStatus);
    const headers = (err as { headers?: unknown })?.headers;
    const retryAfterSeconds =
      retryAfterFromHeaders(headers) ?? retryAfterFromBody(rawMessage);
    const requestId = requestIdFromObj(err, headers);
    let headline = HEADLINE[code] ?? HEADLINE.unknown;
    // Surface the SDK's error.message detail for 4xx — it typically says
    // *what* was wrong (invalid model, unknown tool, malformed input).
    if (httpStatus >= 400 && httpStatus < 500) {
      const detail = pickDetailFromBody(rawMessage);
      if (detail && detail !== headline) headline = `${headline}: ${detail}`;
    }
    return {
      code,
      headline,
      httpStatus,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(requestId ? { requestId } : {}),
      rawMessage,
    };
  }

  return {
    code: "unknown",
    headline: rawMessage.length > 200 ? `${HEADLINE.unknown}: ${rawMessage.slice(0, 200)}…` : rawMessage || HEADLINE.unknown,
    rawMessage,
  };
}

function pickDetailFromBody(raw: string): string | undefined {
  const json = raw.match(/\{[\s\S]*\}\s*$/);
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json[0]) as { error?: { message?: unknown }; message?: unknown };
    const msg =
      (typeof parsed.error?.message === "string" ? parsed.error.message : undefined) ??
      (typeof parsed.message === "string" ? parsed.message : undefined);
    if (msg) return msg.length > 240 ? `${msg.slice(0, 240)}…` : msg;
  } catch {
    return undefined;
  }
  return undefined;
}
