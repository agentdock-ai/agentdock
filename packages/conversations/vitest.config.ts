import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 90,
        lines: 85,
        "src/service.ts": {
          statements: 90,
          branches: 80,
          functions: 95,
          lines: 90,
        },
        "src/store.ts": {
          statements: 90,
          branches: 85,
          functions: 100,
          lines: 90,
        },
      },
    },
  },
});
