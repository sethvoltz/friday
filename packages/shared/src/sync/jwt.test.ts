import { describe, expect, it } from "vitest";
import { mintZeroJwt, verifyZeroJwt } from "./jwt.js";

const SECRET = "test-secret-do-not-use-in-prod";

describe("mintZeroJwt + verifyZeroJwt", () => {
  it("round-trips a payload through mint → verify with matching claims", () => {
    const token = mintZeroJwt({
      userId: "user-123",
      deviceId: "device-abc",
      secret: SECRET,
      nowSec: 1_000_000,
      ttlSec: 600,
    });
    const claims = verifyZeroJwt(token, SECRET, 1_000_100);
    expect(claims).toEqual({
      userId: "user-123",
      deviceId: "device-abc",
      iat: 1_000_000,
      exp: 1_000_600,
    });
  });

  it("rejects a token signed with a different secret", () => {
    const token = mintZeroJwt({
      userId: "u",
      deviceId: "d",
      secret: SECRET,
      nowSec: 1,
      ttlSec: 60,
    });
    expect(verifyZeroJwt(token, "wrong-secret", 1)).toBeNull();
  });

  it("rejects a token whose payload was tampered with", () => {
    const token = mintZeroJwt({
      userId: "u",
      deviceId: "d",
      secret: SECRET,
      nowSec: 1,
      ttlSec: 60,
    });
    const [header, , signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ userId: "u", deviceId: "evil", iat: 1, exp: 100 }),
    ).toString("base64url");
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    expect(verifyZeroJwt(tampered, SECRET, 1)).toBeNull();
  });

  it("rejects a token past its `exp`", () => {
    const token = mintZeroJwt({
      userId: "u",
      deviceId: "d",
      secret: SECRET,
      nowSec: 1_000,
      ttlSec: 60,
    });
    expect(verifyZeroJwt(token, SECRET, 1_060)).toBeNull(); // exact exp = expired
    expect(verifyZeroJwt(token, SECRET, 999_999)).toBeNull();
  });

  it("accepts a token right at `exp - 1`", () => {
    const token = mintZeroJwt({
      userId: "u",
      deviceId: "d",
      secret: SECRET,
      nowSec: 1_000,
      ttlSec: 60,
    });
    expect(verifyZeroJwt(token, SECRET, 1_059)).not.toBeNull();
  });

  it("rejects malformed inputs without throwing", () => {
    expect(verifyZeroJwt("", SECRET)).toBeNull();
    expect(verifyZeroJwt("not.a.jwt", SECRET)).toBeNull();
    expect(verifyZeroJwt("only.two", SECRET)).toBeNull();
    expect(verifyZeroJwt("a.b.c.d", SECRET)).toBeNull();
  });

  it("rejects a token whose payload doesn't have the expected claim shape", async () => {
    // Manually craft a JWT with the right signature but missing required claims.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    );
    const payload = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64url");
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    const token = `${header}.${payload}.${sig}`;
    expect(verifyZeroJwt(token, SECRET, 0)).toBeNull();
  });

  it("default TTL is 15 minutes", () => {
    const token = mintZeroJwt({
      userId: "u",
      deviceId: "d",
      secret: SECRET,
      nowSec: 0,
    });
    const claims = verifyZeroJwt(token, SECRET, 0);
    expect(claims?.exp).toBe(900);
  });
});
