import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../shared/src/test/vitest-setup.ts"],
  },
});
