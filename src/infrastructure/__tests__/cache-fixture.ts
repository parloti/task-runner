import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CompiledTask, TaskEvent } from "../../domain";

import { executeGraph } from "../../application";
import { compileGraph } from "../../domain";
import { createTaskCache } from "../task-cache";

export const cacheConfig = {
  packages: {
    ".": {
      build: { run: { command: "build", kind: "shell" } },
      test: {
        cache: { exclude: ["**/*.log"], inputs: ["src/**/*"] },
        run: { command: "test", kind: "shell" },
      },
      validate: {
        cache: { inputs: ["src/**/*"], outputs: ["dist/**/*"] },
        dependsOn: ["build", "test"],
      },
    },
  },
  version: 2,
} as const;

/**
 * Create an isolated source/output tree for cache scenarios.
 * @returns An owned temporary directory.
 * @example `createCacheFixtureDirectory()` creates the test inputs.
 */
export function createCacheFixtureDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "runner-cache-"));
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "src", "input.ts"), "initial");
  return root;
}

/**
 * Materialize the output of a fixture build command.
 * @param root Owned fixture directory.
 * @param task Command being executed.
 * @returns Completion of the fixture command.
 * @example `executeCacheTask(root, build)` writes the compiled artifact.
 */
export function executeCacheTask(
  root: string,
  task: CompiledTask,
): Promise<void> {
  if (task.id === "build")
    writeFileSync(path.join(root, "dist", "output.js"), "compiled");
  return Promise.resolve();
}

/**
 * Run fixture validation with fresh cache state for each invocation.
 * @param root Owned fixture directory.
 * @param noCache Whether to force execution.
 * @param command Optional failing or input-changing command adapter.
 * @returns Command calls, scheduler events, and the final result.
 * @example `runCachedValidation(root)` exercises persistent cache reuse.
 */
export async function runCachedValidation(
  root: string,
  noCache = false,
  command = (task: CompiledTask) => executeCacheTask(root, task),
) {
  const calls: string[] = [];
  const events: TaskEvent[] = [];
  const result = await executeGraph(
    compileGraph(cacheConfig, "validate"),
    async (task) => {
      calls.push(task.id);
      await command(task);
    },
    {
      cache: createTaskCache(root, noCache),
      concurrency: 1,
      onEvent: (event) => {
        events.push(event);
      },
    },
  );
  return { calls, events, result };
}
