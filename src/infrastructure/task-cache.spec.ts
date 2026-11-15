import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskEvent } from "../domain";

import { executeGraph } from "../application";
import { compileGraph, taskReference } from "../domain";
import {
  cacheConfig,
  createCacheFixtureDirectory,
  executeCacheTask,
  runCachedValidation,
} from "./__tests__";
import { createTaskCache } from "./task-cache";

const fixture = { root: "" };
beforeEach(() => {
  fixture.root = createCacheFixtureDirectory();
});
afterEach(() => {
  rmSync(fixture.root, { force: true, recursive: true });
});

describe("persistent successful checkpoints", () => {
  it("skips an unchanged validation group across cache instances and retains its success time", async () => {
    // Arrange
    const first = await runCachedValidation(fixture.root);
    // Act
    const second = await runCachedValidation(fixture.root);
    // Assert
    expect(first.calls).toEqual(["build", "test"]);
    expect(second.calls).toEqual([]);
    expect(second.result.success).toBe(true);
    expect(second.result.states.values().toArray()).toEqual([
      "cached",
      "cached",
      "cached",
    ]);
    const cached = second.events.find((event) => event.taskId === "validate");
    expect(cached?.status).toBe("cached");
    expect(cached?.completedAt).toMatch(/^\d{4}-/u);
  });

  it.each(["modify", "add", "delete"])(
    "invalidates on input %s",
    async (change) => {
      // Arrange
      const root = fixture.root;
      await runCachedValidation(fixture.root);
      if (change === "modify")
        writeFileSync(path.join(root, "src", "input.ts"), "changed");
      else if (change === "add")
        writeFileSync(path.join(root, "src", "new.ts"), "added");
      else {
        writeFileSync(
          path.join(root, "src", "other.ts"),
          "keep input set nonempty",
        );
        await runCachedValidation(fixture.root);
        rmSync(path.join(root, "src", "input.ts"));
      }
      // Act
      const result = await runCachedValidation(fixture.root);
      // Assert
      expect(result.calls).toEqual(["build", "test"]);
      expect(
        result.events.some((event) => event.cacheReason === "inputs-changed"),
      ).toBe(true);
    },
  );

  it.each(["missing", "modified"])(
    "reruns producers for %s outputs while reusing independent checks",
    async (change) => {
      // Arrange
      await runCachedValidation(fixture.root);
      const output = path.join(fixture.root, "dist", "output.js");
      if (change === "missing") rmSync(output);
      else writeFileSync(output, "corrupted");
      // Act
      const result = await runCachedValidation(fixture.root);
      // Assert
      expect(result.calls).toEqual(["build"]);
      expect(
        result.events.some(
          (event) =>
            event.cacheReason ===
            `outputs-${change === "missing" ? "missing" : "changed"}`,
        ),
      ).toBe(true);
    },
  );

  it("bypasses existing entries and refreshes them after a forced run", async () => {
    // Arrange
    await runCachedValidation(fixture.root);
    // Act
    const forced = await runCachedValidation(fixture.root, true);
    const reused = await runCachedValidation(fixture.root);
    // Assert
    expect(forced.calls).toEqual(["build", "test"]);
    expect(
      forced.events.some((event) => event.cacheReason === "bypassed"),
    ).toBe(true);
    expect(reused.calls).toEqual([]);
  });

  it("bypasses cached groups containing a remembered failed command", async () => {
    // Arrange
    await runCachedValidation(fixture.root);
    const graph = compileGraph(cacheConfig, "validate");
    const calls: string[] = [];
    const events: TaskEvent[] = [];

    // Act
    const result = await executeGraph(
      graph,
      async (task) => {
        calls.push(task.id);
        await executeCacheTask(fixture.root, task);
      },
      {
        cache: createTaskCache(fixture.root),
        concurrency: 1,
        forceRunTasks: [taskReference(".", "test")],
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    // Assert
    expect(result.success).toBe(true);
    expect(calls).toEqual(["build", "test"]);
    expect(
      events
        .filter((event) => event.cacheReason === "retry-priority")
        .map((event) => event.taskId),
    ).toEqual(["validate", "test"]);
  });

  it("invalidates hidden configuration files matched by ordinary input patterns", async () => {
    // Arrange
    const graph = compileGraph(
      {
        packages: {
          ".": {
            test: {
              cache: { inputs: ["**/*"] },
              run: { command: "test", kind: "shell" },
            },
          },
        },
        version: 2,
      },
      "test",
    );
    const file = path.join(fixture.root, ".npmrc");
    writeFileSync(file, "fund=false");
    const command = vi.fn(() => Promise.resolve());
    await executeGraph(graph, command, {
      cache: createTaskCache(fixture.root),
      concurrency: 1,
    });
    // Act
    writeFileSync(file, "fund=true");
    await executeGraph(graph, command, {
      cache: createTaskCache(fixture.root),
      concurrency: 1,
    });
    // Assert
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("invalidates named environment changes without reacting to undeclared variables", async () => {
    // Arrange
    const graph = compileGraph(
      {
        packages: {
          ".": {
            test: {
              cache: { env: ["RUNNER_CACHE_MODE"], inputs: ["src/**/*"] },
              run: { command: "test", kind: "shell" },
            },
          },
        },
        version: 2,
      },
      "test",
    );
    const command = vi.fn(() => Promise.resolve());
    const execute = () =>
      executeGraph(graph, command, {
        cache: createTaskCache(fixture.root),
        concurrency: 1,
      });
    vi.stubEnv("RUNNER_CACHE_MODE", "first");
    try {
      await execute();
      vi.stubEnv("UNDECLARED_CACHE_MODE", "unrelated");
      await execute();
      // Act
      vi.stubEnv("RUNNER_CACHE_MODE", "second");
      await execute();
      // Assert
      expect(command).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
