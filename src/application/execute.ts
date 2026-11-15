import type {
  CompiledTask,
  ExecuteCommand,
  RunResult,
  TaskEvent,
  TaskId,
  TaskStatus,
} from "../domain";

import { normalizeExecutionError, TaskCancelledError } from "../domain";
import {
  type ExecutionCache,
  prepareCachedTasks,
  storeSuccessfulTasks,
} from "./task-cache";

export interface ExecutionOptions {
  readonly cache?: ExecutionCache;
  readonly concurrency: number;
  readonly forceRunTasks?: readonly TaskId[];
  readonly onEvent?: (event: TaskEvent) => void;
  readonly priorityTasks?: readonly TaskId[];
  readonly signal?: AbortSignal;
}

/**
 * Execute a validated task graph with bounded command concurrency.
 * @param graph Validated tasks keyed by canonical task ID.
 * @param execute Adapter that runs one command task.
 * @param options Concurrency, task priority, cancellation, and event callbacks.
 * @returns Final state and error information for the graph.
 * @example `executeGraph(graph, execute, { concurrency: 2 })` runs at most two commands at once.
 */
export async function executeGraph(
  graph: ReadonlyMap<TaskId, CompiledTask>,
  execute: ExecuteCommand,
  options: ExecutionOptions,
): Promise<RunResult> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const states = new Map<TaskId, TaskStatus>();
  const completedAt = new Map<TaskId, string>();
  const active = new Map<TaskId, Promise<void>>();
  const errors: unknown[] = [];
  const forceRunTasks = new Set(options.forceRunTasks);
  const priorityTasks = new Set<TaskId>();
  const prioritize = (id: TaskId): void => {
    if (priorityTasks.has(id)) return;
    const task = graph.get(id);
    if (task === undefined) return;
    priorityTasks.add(id);
    for (const dependency of task.dependsOn) prioritize(dependency);
  };
  const requestedPriorityTasks = options.priorityTasks ?? [];
  for (const id of requestedPriorityTasks) prioritize(id);
  const orderedTasks = graph
    .values()
    .toArray()
    .toSorted(
      (left, right) =>
        Number(priorityTasks.has(right.id)) -
        Number(priorityTasks.has(left.id)),
    );
  const transition = (
    task: CompiledTask,
    status: TaskStatus,
    durationMs?: number,
    error?: Error,
  ): void => {
    states.set(task.id, status);
    if (status === "succeeded")
      completedAt.set(task.id, new Date().toISOString());
    const cachedAt = cached.get(task.id);
    options.onEvent?.({
      package: task.package,
      status,
      taskId: task.id,
      ...(status === "cached" &&
        cachedAt !== undefined && { completedAt: cachedAt, durationMs: 0 }),
      ...(durationMs !== undefined && { durationMs }),
      ...(error !== undefined && { error }),
    });
  };
  for (const task of graph.values()) states.set(task.id, "pending");
  let cached: ReadonlyMap<TaskId, string> = new Map();
  const start = (task: CompiledTask): void => {
    transition(task, "ready");
    transition(task, "running");
    const started = Date.now();
    const execution = Promise.try(async () => {
      try {
        await execute(task, controller.signal);
        transition(task, "succeeded", Date.now() - started);
      } catch (error) {
        const failure = normalizeExecutionError(error);
        const interrupted = controller.signal.aborted;
        const cancelled = failure instanceof TaskCancelledError;
        if (!cancelled) errors.push(failure);
        controller.abort(failure);
        transition(
          task,
          interrupted || cancelled ? "cancelled" : "failed",
          Date.now() - started,
          cancelled ? undefined : failure,
        );
      } finally {
        active.delete(task.id);
      }
    });
    active.set(task.id, execution);
  };
  try {
    if (options.cache !== undefined && !controller.signal.aborted)
      cached = await prepareCachedTasks(
        graph,
        options.cache,
        options.onEvent,
        forceRunTasks,
      );
    while (
      states.values().some((state) => state === "pending") ||
      active.size > 0
    ) {
      let progressed = false;
      for (const task of orderedTasks) {
        if (states.get(task.id) !== "pending") continue;
        const dependencies = task.dependsOn.map((id) => states.get(id));
        if (
          dependencies.some(
            (state) =>
              state === "failed" ||
              state === "blocked" ||
              state === "cancelled",
          )
        ) {
          transition(task, "blocked");
        } else if (controller.signal.aborted) {
          transition(task, "cancelled");
        } else if (
          dependencies.every(
            (state) => state === "succeeded" || state === "cached",
          )
        ) {
          if (cached.has(task.id)) {
            transition(task, "cached");
          } else if (task.run === undefined) {
            transition(task, "succeeded");
          } else if (active.size < options.concurrency) {
            start(task);
          } else continue;
        } else continue;
        progressed = true;
      }
      if (active.size > 0) await Promise.race(active.values());
      else if (
        !progressed &&
        states.values().some((state) => state === "pending")
      ) {
        throw new Error("Task graph cannot make progress");
      }
    }
  } finally {
    controller.abort();
    options.signal?.removeEventListener("abort", cancel);
    await Promise.allSettled(active.values());
  }
  if (options.cache !== undefined) {
    try {
      await storeSuccessfulTasks(
        graph,
        options.cache,
        states,
        completedAt,
        options.onEvent,
      );
    } catch (error) {
      errors.push(normalizeExecutionError(error));
    }
  }
  return {
    errors,
    states,
    success:
      errors.length === 0 &&
      states
        .values()
        .every((state) => !["blocked", "cancelled", "failed"].includes(state)),
  };
}
