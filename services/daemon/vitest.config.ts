import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts"],
    setupFiles: ["../../packages/shared/src/test/vitest-setup.ts"],
  },
});
