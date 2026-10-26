import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeGraph } from "../application";
import { runTasks } from "./run";

vi.mock("../application", () => ({ executeGraph: vi.fn() }));
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
    { ci: false, cpus: 8, expected: 7, requested: undefined },
    { ci: false, cpus: 1, expected: 1, requested: undefined },
    { ci: true, cpus: 8, expected: 1, requested: undefined },
    { ci: false, cpus: 8, expected: 3, requested: 3 },
    { ci: true, cpus: 8, expected: 3, requested: 3 },
  ])(
    "uses $expected slots for CPUs=$cpus, CI=$ci, explicit=$requested",
    async ({ ci, cpus, expected, requested }) => {
      // Arrange
      const directory = mkdtempSync(path.join(tmpdir(), "runner-concurrency-"));
      writeFileSync(path.join(directory, "package.json"), "{}");
      writeFileSync(
        path.join(directory, "task-runner.json"),
        JSON.stringify({
          packages: { ".": { check: { dependsOn: ["end"] }, end: {} } },
          version: 2,
        }),
      );
      vi.stubEnv("CI", "");
      vi.mocked(availableParallelism).mockReturnValue(cpus);
      vi.mocked(executeGraph).mockResolvedValue({
        errors: [],
        states: new Map(),
        success: true,
      });
      try {
        // Act
        await runTasks("check", {
          ci,
          cwd: directory,
          ...(requested !== undefined && { concurrency: requested }),
        });
        // Assert
        expect(executeGraph).toHaveBeenCalledWith(
          expect.any(Map),
          expect.any(Function),
          expect.objectContaining({ concurrency: expected }),
        );
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
});
