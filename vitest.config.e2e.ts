import { defineConfig } from "vitest/config";

const config = defineConfig({
  test: {
    clearMocks: true,
    coverage: {
      enabled: true,
      exclude: ["**/*.spec.ts"],
      include: ["src/**/*.ts"],
      reportsDirectory: "coverage/e2e",
      thresholds: { branches: 15, functions: 15, lines: 15, statements: 15 },
    },
    include: ["tests/e2e/**/*.e2e.ts"],
    maxWorkers: "50%",
    mockReset: true,
    name: "task-runner-e2e",
    pool: "threads",
    restoreMocks: true,
    setupFiles: ["vitest.setup.ts"],
    testTimeout: 60_000,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});

export default config;
