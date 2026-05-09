import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { loadConfig } from "@friday/shared";

// When a Cloudflare Tunnel is configured, Vite's host-header check would
// otherwise reject requests proxied in under the public hostname. Pull
// `publicUrl` from `~/.friday/config.json` (set via `friday setup
// --cloudflare`) and add its hostname to `server.allowedHosts`.
function tunnelHost(): string | null {
  try {
    const cfg = loadConfig();
    if (!cfg.publicUrl) return null;
    return new URL(cfg.publicUrl).hostname || null;
  } catch {
    return null;
  }
}

const allowedHosts = ["localhost", "127.0.0.1"];
const tHost = tunnelHost();
if (tHost) allowedHosts.push(tHost);

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    allowedHosts,
  },
});
