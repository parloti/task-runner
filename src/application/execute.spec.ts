import { describe, expect, it } from "vitest";

import type { RunnerConfig, TaskEvent } from "../domain";

import {
  compileGraph,
  normalizeExecutionError,
  TaskCancelledError,
  taskReference,
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
        end: { dependsOn: ["shared", "a", "b"] },
        shared: { run: { command: "shared", kind: "shell" } },
      },
    },
    version: 2,
  };
  return compileGraph(config, "end");
}

describe("execution", () => {
  it("schedules priority tasks and their shared prerequisites before ordinary work", async () => {
    // Arrange
    const plan = compileGraph(
      {
        packages: {
          ".": {
            current: { run: { command: "current", kind: "shell" } },
            first: {
              dependsOn: ["shared"],
              run: { command: "first", kind: "shell" },
            },
            plan: { dependsOn: ["current", "shared", "first", "second"] },
            second: {
              dependsOn: ["shared"],
              run: { command: "second", kind: "shell" },
            },
            shared: { run: { command: "shared", kind: "shell" } },
          },
        },
        version: 2,
      },
      "plan",
      ["first", "second"],
    );
    const calls: string[] = [];

    // Act
    const result = await executeGraph(
      plan,
      (task) => {
        calls.push(task.id);
        return Promise.resolve();
      },
      {
        concurrency: 1,
        priorityTasks: [
          taskReference(".", "first"),
          taskReference(".", "second"),
          taskReference(".", "missing"),
        ],
      },
    );

    // Assert
    expect(result.success).toBe(true);
    expect(calls).toEqual(["shared", "first", "second", "current"]);
  });

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

  it("keeps running independent work after failure and blocks dependents", async () => {
    const calls: string[] = [];
    let siblingWasAborted = false;
    const result = await executeGraph(
      graph(),
      async (task, signal) => {
        calls.push(task.id);
        if (task.id === "a") throw new Error("broken");
        if (task.id !== "b") return;
        await new Promise((resolve) => setTimeout(resolve, 5));
        siblingWasAborted = signal.aborted;
      },
      { concurrency: 2 },
    );
    expect(result.success).toBe(false);
    expect(calls).toEqual(["shared", "a", "b"]);
    expect(siblingWasAborted).toBe(false);
    expect(result.states.get(taskReference(".", "a"))).toBe("failed");
    expect(result.states.get(taskReference(".", "b"))).toBe("succeeded");
    expect(result.states.get(taskReference(".", "end"))).toBe("blocked");
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
          keepGoing: false,
          onEvent: (event) => {
            events.push(event);
          },
        },
      );
      // Assert
      expect(result.success).toBe(false);
      expect(cleanedUp).toBe(true);
      const terminal = events.find(
        (event) => event.taskId === "b" && event.status === "cancelled",
      );
      expect(terminal?.error).toEqual(
        expectedCancellation ? undefined : new Error("sibling cleanup failed"),
      );
      expect(result.errors).toHaveLength(expectedCancellation ? 1 : 2);
      expect(terminal).toHaveProperty("cancellation", {
        kind: "task-failed",
        reason: "original failure",
        taskId: "a",
      });
    },
  );

  it("records executor cancellation without an error diagnostic before the signal is aborted", async () => {
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
    expect(result.errors).toEqual([]);
    const cancellation = events.find((event) => event.status === "cancelled");
    expect(cancellation).not.toHaveProperty("error");
    expect(cancellation).toHaveProperty("cancellation", {
      kind: "executor",
      reason: "Cancelled task: shared",
      taskId: "shared",
    });
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
