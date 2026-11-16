import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { RunOptions } from "../application";
import type { RunResult, TaskEvent } from "../domain";

import { executeGraph } from "../application";
import { compileGraph, resolveTaskReference, taskReference } from "../domain";
import {
  createFailedTaskStore,
  createProcessExecutor,
  createTaskCache,
  findConfiguration,
  findPackage,
  parseConfiguration,
} from "../infrastructure";
import { prepareRunLogDirectory } from "./run-logs";

/**
 * Load configuration and run the selected task entrypoint.
 * @param entrypoint Local or qualified task reference to execute.
 * @param options Working directory, package scope, and run controls.
 * @returns Final task states and command errors.
 * @example `runTasks("build")` runs the local `build` task.
 */
export async function runTasks(
  entrypoint: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = findConfiguration(cwd, options.config);
  const root = path.dirname(configPath);
  const config = parseConfiguration(
    JSON.parse(readFileSync(configPath, "utf8")) as unknown,
  );
  const packagePath = options.package ?? findPackage(config, root, cwd);
  const tasks = config.packages[packagePath];
  if (tasks === undefined || !Object.hasOwn(tasks, entrypoint))
    throw new Error(`Unknown task "${entrypoint}" in package ${packagePath}`);
  const target = taskReference(packagePath, entrypoint);
  const failureStore = createFailedTaskStore(root, configPath);
  const configuredCommands = new Set<string>();
  for (const [configuredPackage, definitions] of Object.entries(
    config.packages,
  ))
    for (const [name, definition] of Object.entries(definitions))
      if (definition.run !== undefined)
        configuredCommands.add(taskReference(configuredPackage, name));
  const savedFailures = await failureStore.read();
  const retryTargets = savedFailures.filter((id) => configuredCommands.has(id));
  const graph = compileGraph(config, target, retryTargets);
  const priorityTasks = retryTargets.map((id) => resolveTaskReference(".", id));
  const packagePaths = Object.keys(config.packages);
  const ci =
    Boolean(process.env["CI"]) || (options.ci ?? config.defaults?.ci ?? false);
  const concurrency =
    options.concurrency ??
    config.defaults?.concurrency ??
    (ci ? 1 : Math.max(1, Math.floor(availableParallelism() / 2)));
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error("Concurrency must be a positive integer");
  options.onPlan?.(graph, target, packagePaths);
  const runId = randomUUID();
  const { directory, release } = await prepareRunLogDirectory(root, runId);
  const onEvent = (event: TaskEvent): void => {
    appendFileSync(
      path.join(directory, `events-${runId}.jsonl`),
      `${JSON.stringify({
        runId,
        timestamp: new Date().toISOString(),
        ...event,
        ...(event.error !== undefined && { error: event.error.message }),
      })}\n`,
    );
    options.onEvent?.(event);
  };
  let result: RunResult | undefined;
  let executionFailed = false;
  let executionError: unknown;
  let completedAt: number | undefined;
  try {
    result = await executeGraph(
      graph,
      createProcessExecutor(root, directory, ci, packagePaths),
      {
        cache: createTaskCache(
          root,
          options.noCache ?? config.defaults?.noCache,
        ),
        concurrency,
        forceRunTasks: priorityTasks,
        keepGoing: options.keepGoing ?? config.defaults?.keepGoing ?? false,
        onEvent,
        priorityTasks,
        ...(options.signal !== undefined && { signal: options.signal }),
      },
    );
    completedAt = performance.timeOrigin + performance.now();
  } catch (error) {
    executionFailed = true;
    executionError = error;
  }

  if (!executionFailed && result !== undefined && completedAt !== undefined) {
    try {
      await failureStore.write(
        [...result.states]
          .filter(([, status]) => status === "failed")
          .map(([taskId]) => taskId),
        completedAt,
        runId,
      );
    } catch (error) {
      result = { ...result, errors: [...result.errors, error], success: false };
    }
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    release();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (executionFailed && cleanupFailed)
    throw new AggregateError(
      [executionError, cleanupError],
      "Task execution and log cleanup failed",
      { cause: cleanupError },
    );
  if (executionFailed) throw executionError;
  if (cleanupFailed) throw cleanupError;
  if (result === undefined) throw new Error("Execution returned no result");
  return result;
}
