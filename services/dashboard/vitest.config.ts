import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts", "e2e/**"],
    setupFiles: ["../../packages/shared/src/test/vitest-setup.ts"],
  },
});
