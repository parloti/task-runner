import { describe, expect, it } from "vitest";

import type { RunnerConfig, TaskEvent } from "../domain";

import {
  compileGraph,
  normalizeExecutionError,
  TaskCancelledError,
} from "../domain";
import { executeGraph } from "./execute";

/**
 * Build the validated graph shared by executor tests.
 * @returns The graph used by execution scenarios.
 * @example `graph()` returns the task graph rooted at `end`.
 */
function graph() {
  const config: RunnerConfig = {
    packages: {
      ".": {
        a: { dependsOn: ["shared"], run: { command: "a", kind: "shell" } },
        b: { dependsOn: ["shared"], run: { command: "b", kind: "shell" } },
        docs: { run: { kind: "npm", optional: true, script: "docs" } },
        end: { dependsOn: ["a", "b", "docs"] },
        shared: { run: { command: "shared", kind: "shell" } },
      },
    },
    version: 2,
  };
  return compileGraph(config, "end", new Map([[".", {}]]));
}

describe("execution", () => {
  it.each([1, 2, 3])(
    "limits leaf concurrency to %i and runs shared work once",
    async (concurrency) => {
      // Arrange
      let active = 0;
      let peak = 0;
      const calls: string[] = [];
      const events: TaskEvent[] = [];
      // Act
      const result = await executeGraph(
        graph(),
        async (task) => {
          calls.push(task.id);
          peak = Math.max(peak, ++active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active--;
        },
        {
          concurrency,
          onEvent: (event) => {
            events.push(event);
          },
        },
      );
      // Assert
      expect(result.success).toBe(true);
      expect(calls).toEqual(["shared", "a", "b"]);
      expect(peak).toBe(Math.min(2, concurrency));
      expect(result.states.values().toArray()).toContain("skipped");
      expect(events.filter((event) => event.status === "running")).toHaveLength(
        3,
      );
    },
  );

  it("blocks dependents after failure and does not admit queued work", async () => {
    // Arrange
    const calls: string[] = [];
    // Act
    const result = await executeGraph(
      graph(),
      (task) => {
        calls.push(task.id);
        return Promise.reject(new Error("broken"));
      },
      { concurrency: 1 },
    );
    // Assert
    expect(result.success).toBe(false);
    expect(calls).toEqual(["shared"]);
    expect(result.states.values().toArray()).toContain("blocked");
    expect(result.errors).toHaveLength(1);
  });

  it("normalizes non-Error executor failures without losing the cause", async () => {
    // Arrange & Act
    const failure = normalizeExecutionError("external failure");
    const result = await executeGraph(graph(), () => Promise.reject(failure), {
      concurrency: 1,
    });
    // Assert
    expect(result.success).toBe(false);
    expect(result.errors[0]).toBe(failure);
    expect(failure).toMatchObject({
      cause: "external failure",
      message: "external failure",
    });
  });

  it("does not start commands after pre-existing cancellation", async () => {
    // Arrange
    const controller = new AbortController();
    controller.abort();
    // Act
    const result = await executeGraph(
      graph(),
      () => Promise.reject(new Error("must not run")),
      { concurrency: 1, signal: controller.signal },
    );
    // Assert
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it.each([0, -1, 0.5, NaN])(
    "rejects invalid concurrency %s",
    async (concurrency) => {
      // Arrange & Act & Assert
      await expect(
        executeGraph(graph(), () => Promise.resolve(), { concurrency }),
      ).rejects.toThrow("positive integer");
    },
  );

  it.each([false, true])(
    "awaits sibling cleanup and suppresses only expected cancellation: %s",
    async (expectedCancellation) => {
      // Arrange
      const compiled = graph();
      let cleanedUp = false;
      const events: TaskEvent[] = [];
      // Act
      const result = await executeGraph(
        compiled,
        async (task, signal) => {
          if (task.id === "shared") return;
          if (task.id === "a") {
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw new Error("original failure");
          }
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                cleanedUp = true;
                reject(
                  expectedCancellation
                    ? new TaskCancelledError("sibling")
                    : new Error("sibling cleanup failed"),
                );
              },
              { once: true },
            );
          });
        },
        {
          concurrency: 2,
          onEvent: (event) => {
            events.push(event);
          },
        },
      );
      // Assert
      expect(result.success).toBe(false);
      expect(cleanedUp).toBe(true);
      expect(
        events.some(
          (event) =>
            event.status === "cancelled" &&
            (expectedCancellation
              ? event.error === undefined
              : event.error instanceof Error),
        ),
      ).toBe(true);
      expect(result.errors).toHaveLength(expectedCancellation ? 1 : 2);
    },
  );

  it("records executor cancellation without a diagnostic even before a signal is aborted", async () => {
    // Arrange
    const events: TaskEvent[] = [];
    // Act
    const result = await executeGraph(
      graph(),
      () => Promise.reject(new TaskCancelledError("shared")),
      {
        concurrency: 1,
        onEvent: (event) => {
          events.push(event);
        },
      },
    );
    // Assert
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(
      events.find(
        (event) => event.taskId === "shared" && event.status === "cancelled",
      ),
    ).not.toHaveProperty("error");
  });

  it("rejects an inconsistent externally supplied graph instead of hanging", async () => {
    // Arrange
    const compiled = graph();
    const tasks = compiled.values().toArray();
    const first = tasks.at(0);
    const last = tasks.at(-1);
    if (first === undefined || last === undefined)
      throw new Error("Expected the compiled graph to contain tasks");
    const cyclic = new Map(compiled).set(first.id, {
      ...first,
      dependsOn: [last.id],
    });
    // Act & Assert
    await expect(
      executeGraph(cyclic, () => Promise.resolve(), { concurrency: 1 }),
    ).rejects.toThrow("cannot make progress");
  });
});
