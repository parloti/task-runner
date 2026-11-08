import { defineConfig } from "vitest/config";

const config = defineConfig({
  cacheDir: "node_modules/.vitest/e2e",
  test: {
    clearMocks: true,
    coverage: {
      enabled: true,
      exclude: ["**/*.spec.ts"],
      include: ["src/**/*.ts"],
      reportsDirectory: "coverage/e2e",
      thresholds: { branches: 20, functions: 20, lines: 20, statements: 20 },
    },
    fsModuleCachePath: "node_modules/.vitest-cache/e2e",
    include: ["tests/e2e/**/*.e2e.ts"],
    mockReset: true,
    name: "task-runner-e2e",
    restoreMocks: true,
    setupFiles: ["vitest.setup.ts"],
    testTimeout: 60_000,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});

export default config;
