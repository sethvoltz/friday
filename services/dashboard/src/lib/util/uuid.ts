/**
 * Secure-context-safe UUID v4.
 *
 * `crypto.randomUUID()` is only exposed in a SECURE CONTEXT (HTTPS or
 * `localhost`). On an insecure origin — notably a plain-HTTP LAN IP like
 * `http://192.168.x.y:5173` used for on-device dev testing — Safari
 * leaves `crypto.randomUUID` undefined, so calling it throws and breaks
 * the send path. Production (HTTPS via the Cloudflare Tunnel) and the
 * installed PWA are always secure contexts, so this only bites dev, but
 * the fallback is cheap and keeps LAN testing working.
 *
 * `crypto.getRandomValues` IS available on insecure origins, so the
 * fallback builds a proper v4 UUID from it; a final `Math.random` branch
 * covers the (essentially impossible in a browser) no-WebCrypto case so
 * this never throws.
 */
export function randomUUID(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Per RFC 4122 §4.4: set version (4) and variant (10xx) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 256; i++) hex.push((i + 0x100).toString(16).slice(1));
  const b = bytes;
  return (
    hex[b[0]] +
    hex[b[1]] +
    hex[b[2]] +
    hex[b[3]] +
    "-" +
    hex[b[4]] +
    hex[b[5]] +
    "-" +
    hex[b[6]] +
    hex[b[7]] +
    "-" +
    hex[b[8]] +
    hex[b[9]] +
    "-" +
    hex[b[10]] +
    hex[b[11]] +
    hex[b[12]] +
    hex[b[13]] +
    hex[b[14]] +
    hex[b[15]]
  );
}
