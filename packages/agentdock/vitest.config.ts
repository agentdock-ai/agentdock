import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.mjs"],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      thresholds: {
        // Measured baseline from the current core test suite. Keep these floors
        // stable so new changes cannot silently reduce coverage.
        statements: 85.33,
        branches: 76.52,
        functions: 92.61,
        lines: 88.47,
      },
    },
  },
});
