import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    alias: {
      $lib: "./src/lib",
    },
    // PostHog session replay rewrites asset URLs when reconstructing the
    // DOM; relative paths break that reconstruction. PostHog's SvelteKit
    // guide requires absolute asset paths (https://posthog.com/docs/libraries/svelte).
    paths: {
      relative: false,
    },
  },
};

export default config;
