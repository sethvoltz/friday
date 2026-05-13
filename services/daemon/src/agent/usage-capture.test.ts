import { describe, expect, it } from "vitest";
import { extractUsageFromResult } from "./usage-capture.js";

describe("extractUsageFromResult", () => {
  it("maps a result message with usage and total_cost_usd to the worker-protocol shape", () => {
    const msg = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.1234,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
    };
    expect(extractUsageFromResult(msg)).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_tokens: 10,
      cache_read_tokens: 5,
      cost_usd: 0.1234,
    });
  });

  it("returns undefined for a result message with no usage block", () => {
    const msg = { type: "result", total_cost_usd: 0.0 };
    expect(extractUsageFromResult(msg)).toBeUndefined();
  });

  it("returns undefined for non-result messages", () => {
    expect(extractUsageFromResult({ type: "assistant" })).toBeUndefined();
    expect(extractUsageFromResult({ type: "stream_event" })).toBeUndefined();
    expect(extractUsageFromResult({})).toBeUndefined();
  });

  it("defaults missing numeric fields to zero", () => {
    const msg = {
      type: "result",
      usage: { input_tokens: 7 },
    };
    expect(extractUsageFromResult(msg)).toEqual({
      input_tokens: 7,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: 0,
    });
  });

  it("coerces non-numeric total_cost_usd to zero", () => {
    const msg = {
      type: "result",
      total_cost_usd: "0.42",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
    const out = extractUsageFromResult(msg);
    expect(out?.cost_usd).toBe(0);
  });
});
