import type {
  CompiledTask,
  ExecuteCommand,
  RunResult,
  TaskEvent,
  TaskId,
  TaskStatus,
} from "../domain/types.js";
import { TaskCancelledError } from "../domain/execution-errors.js";

export interface ExecutionOptions {
  readonly concurrency: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: TaskEvent) => void;
}

export async function executeGraph(
  graph: ReadonlyMap<TaskId, CompiledTask>,
  execute: ExecuteCommand,
  options: ExecutionOptions,
): Promise<RunResult> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("Concurrency must be a positive integer");
  }
  const controller = new AbortController();
  const cancel = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const states = new Map<TaskId, TaskStatus>();
  const active = new Map<TaskId, Promise<void>>();
  const errors: unknown[] = [];
  const transition = (
    task: CompiledTask,
    status: TaskStatus,
    durationMs?: number,
    error?: Error,
  ): void => {
    states.set(task.id, status);
    options.onEvent?.({
      taskId: task.id,
      package: task.package,
      status,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(error === undefined ? {} : { error }),
    });
  };
  for (const task of graph.values()) states.set(task.id, "pending");
  const start = (task: CompiledTask): void => {
    transition(task, "ready");
    transition(task, "running");
    const started = Date.now();
    const execution = Promise.resolve().then(async () => {
      try {
        await execute(task, controller.signal);
        transition(task, "succeeded", Date.now() - started);
      } catch (error) {
        const failure =
          error instanceof Error
            ? error
            : new Error(String(error), { cause: error });
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
    while (
      [...states.values()].some((state) => state === "pending") ||
      active.size > 0
    ) {
      let progressed = false;
      for (const task of graph.values()) {
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
            (state) => state === "succeeded" || state === "skipped",
          )
        ) {
          if (task.skip || task.run === undefined) {
            transition(task, task.skip ? "skipped" : "succeeded");
          } else if (active.size < options.concurrency) {
            start(task);
          } else continue;
        } else continue;
        progressed = true;
      }
      if (active.size > 0) await Promise.race(active.values());
      else if (
        !progressed &&
        [...states.values()].some((state) => state === "pending")
      ) {
        throw new Error("Task graph cannot make progress");
      }
    }
  } finally {
    controller.abort();
    options.signal?.removeEventListener("abort", cancel);
    await Promise.allSettled(active.values());
  }
  return {
    success: ![...states.values()].some((state) =>
      ["failed", "cancelled", "blocked"].includes(state),
    ),
    states,
    errors,
  };
}
