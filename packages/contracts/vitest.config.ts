import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 95,
        functions: 100,
        lines: 100,
      },
    },
  },
});
