import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeGraph } from "../application/execute.js";
import { runTasks } from "./run.js";

vi.mock("../application/execute.js", () => ({ executeGraph: vi.fn() }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("runtime concurrency policy", () => {
  it.each([
    { cpus: 8, ci: false, requested: undefined, expected: 7 },
    { cpus: 1, ci: false, requested: undefined, expected: 1 },
    { cpus: 8, ci: true, requested: undefined, expected: 1 },
    { cpus: 8, ci: false, requested: 3, expected: 3 },
    { cpus: 8, ci: true, requested: 3, expected: 3 },
  ])(
    "uses $expected slots for CPUs=$cpus, CI=$ci, explicit=$requested",
    async ({ cpus, ci, requested, expected }) => {
      // Arrange
      const directory = mkdtempSync(path.join(tmpdir(), "runner-concurrency-"));
      writeFileSync(path.join(directory, "package.json"), "{}");
      writeFileSync(
        path.join(directory, "task-runner.json"),
        JSON.stringify({
          version: 2,
          packages: { ".": { end: {}, check: { dependsOn: ["end"] } } },
        }),
      );
      vi.stubEnv("CI", "");
      vi.mocked(availableParallelism).mockReturnValue(cpus);
      vi.mocked(executeGraph).mockResolvedValue({
        success: true,
        states: new Map(),
        errors: [],
      });
      try {
        // Act
        await runTasks("check", {
          cwd: directory,
          ci,
          ...(requested === undefined ? {} : { concurrency: requested }),
        });
        // Assert
        expect(executeGraph).toHaveBeenCalledWith(
          expect.any(Map),
          expect.any(Function),
          expect.objectContaining({ concurrency: expected }),
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
