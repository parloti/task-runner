import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeGraph } from "../application";
import { compileGraph, TaskCancelledError } from "../domain";
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

describe("cache failures and interrupted work", () => {
  it("rejects symbolic-link inputs rather than trusting an untracked target", async () => {
    // Arrange
    const target = path.join(fixture.root, "target");
    mkdirSync(target);
    writeFileSync(path.join(target, "source.ts"), "linked");
    symlinkSync(target, path.join(fixture.root, "src", "linked"), "junction");
    // Act & Assert
    await expect(runCachedValidation(fixture.root)).rejects.toThrow(
      "Symbolic-link cache input",
    );
  });

  it("does not record cancelled commands", async () => {
    // Arrange
    const controller = new AbortController();
    const graph = compileGraph(cacheConfig, "test");
    await executeGraph(
      graph,
      () => {
        controller.abort();
        return Promise.reject(new TaskCancelledError("test"));
      },
      {
        cache: createTaskCache(fixture.root),
        concurrency: 1,
        signal: controller.signal,
      },
    );
    const command = vi.fn(() => Promise.resolve());
    // Act
    await executeGraph(graph, command, {
      cache: createTaskCache(fixture.root),
      concurrency: 1,
    });
    // Assert
    expect(command).toHaveBeenCalledOnce();
  });

  it("reports cache persistence failures without losing command failures", async () => {
    // Arrange
    writeFileSync(path.join(fixture.root, ".cache"), "not a directory");
    const graph = compileGraph(
      {
        ...cacheConfig,
        packages: {
          ".": {
            ...cacheConfig.packages["."],
            build: {
              ...cacheConfig.packages["."].build,
              cache: { inputs: ["src/**/*"] },
            },
          },
        },
      },
      "validate",
    );
    const commandError = new Error("test failed");
    // Act
    const result = await executeGraph(
      graph,
      (task) =>
        task.id === "build"
          ? executeCacheTask(fixture.root, task)
          : Promise.reject(commandError),
      { cache: createTaskCache(fixture.root, true), concurrency: 1 },
    );
    // Assert
    expect(result.success).toBe(false);
    expect(result.errors).toContain(commandError);
    expect(result.errors).toHaveLength(2);
  });

  it("keeps successful checkpoints but never records failed work", async () => {
    // Arrange
    const graph = compileGraph(
      {
        packages: {
          ".": {
            a: {
              cache: { inputs: ["src/**/*"] },
              run: { command: "a", kind: "shell" },
            },
            b: {
              cache: { inputs: ["src/**/*"] },
              dependsOn: ["a"],
              run: { command: "b", kind: "shell" },
            },
            validate: { dependsOn: ["a", "b"] },
          },
        },
        version: 2,
      },
      "validate",
    );
    await executeGraph(
      graph,
      (task) =>
        task.id === "b"
          ? Promise.reject(new Error("failed"))
          : Promise.resolve(),
      { cache: createTaskCache(fixture.root), concurrency: 1 },
    );
    const calls: string[] = [];
    // Act
    const result = await executeGraph(
      graph,
      (task) => {
        calls.push(task.id);
        return Promise.resolve();
      },
      { cache: createTaskCache(fixture.root), concurrency: 1 },
    );
    // Assert
    expect(result.success).toBe(true);
    expect(calls).toEqual(["b"]);
  });

  it("does not publish a success against inputs changed during execution", async () => {
    // Arrange & Act
    const first = await runCachedValidation(
      fixture.root,
      false,
      async (task) => {
        await executeCacheTask(fixture.root, task);
        writeFileSync(
          path.join(fixture.root, "src", "input.ts"),
          "changed mid-run",
        );
      },
    );
    const second = await runCachedValidation(fixture.root);
    // Assert
    expect(
      first.events.some(
        (event) => event.cacheReason === "inputs-changed-during-run",
      ),
    ).toBe(true);
    expect(second.calls).toEqual(["build", "test"]);
  });

  it.each(["{}", "{"])(
    "fails visibly on malformed record %s but --no-cache repairs it",
    async (source) => {
      // Arrange
      await runCachedValidation(fixture.root);
      const directory = path.join(fixture.root, ".cache", "task-runner");
      for (const file of readdirSync(directory))
        writeFileSync(path.join(directory, file), source);
      // Act & Assert
      await expect(runCachedValidation(fixture.root)).rejects.toThrow(
        "Invalid task cache record",
      );
      await expect(
        runCachedValidation(fixture.root, true),
      ).resolves.toMatchObject({ calls: ["build", "test"] });
      for (const file of readdirSync(directory)) {
        const record: unknown = JSON.parse(
          readFileSync(path.join(directory, file), "utf8"),
        );
        expect(record).toHaveProperty("version", 1);
      }
      await expect(runCachedValidation(fixture.root)).resolves.toMatchObject({
        calls: [],
      });
    },
  );
});
