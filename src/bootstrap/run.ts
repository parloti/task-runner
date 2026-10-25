import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";

import { executeGraph } from "../application/execute.js";
import type { RunOptions } from "../application/run-options.js";
import { compileGraph } from "../domain/graph.js";
import { taskReference } from "../domain/task-reference.js";
import type { RunResult, TaskEvent } from "../domain/types.js";
import {
  findConfiguration,
  findPackage,
  loadScripts,
  parseConfiguration,
} from "../infrastructure/configuration.js";
import { createProcessExecutor } from "../infrastructure/process.js";

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
  const directory = path.join(root, "logs", "task-runner", String(process.pid));
  mkdirSync(directory, { recursive: true });
  const onEvent = (event: TaskEvent): void => {
    appendFileSync(
      path.join(directory, `events-${runId}.jsonl`),
      `${JSON.stringify({
        runId,
        timestamp: new Date().toISOString(),
        ...event,
        ...(event.error === undefined ? {} : { error: event.error.message }),
      })}\n`,
    );
    options.onEvent?.(event);
  };
  return executeGraph(graph, createProcessExecutor(root, directory, ci), {
    concurrency,
    onEvent,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
