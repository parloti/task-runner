import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";

import type { RunOptions } from "../application";
import type { RunResult, TaskEvent } from "../domain";

import { executeGraph } from "../application";
import { compileGraph, taskReference } from "../domain";
import {
  createProcessExecutor,
  findConfiguration,
  findPackage,
  loadScripts,
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
    JSON.parse(readFileSync(configPath, "utf8")),
  );
  const packagePath = options.package ?? findPackage(config, root, cwd);
  const tasks = config.packages[packagePath];
  if (tasks === undefined || !Object.hasOwn(tasks, entrypoint))
    throw new Error(`Unknown task "${entrypoint}" in package ${packagePath}`);
  const target = taskReference(packagePath, entrypoint);
  const scripts = loadScripts(config, root);
  const graph = compileGraph(config, target, scripts);
  const ci = Boolean(process.env["CI"]) || options.ci === true;
  const concurrency =
    options.concurrency ?? (ci ? 1 : Math.max(1, availableParallelism() - 1));
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error("Concurrency must be a positive integer");
  options.onPlan?.(graph, target);
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
  try {
    result = await executeGraph(
      graph,
      createProcessExecutor(root, directory, ci),
      {
        concurrency,
        onEvent,
        ...(options.signal !== undefined && { signal: options.signal }),
      },
    );
  } catch (error) {
    executionFailed = true;
    executionError = error;
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
