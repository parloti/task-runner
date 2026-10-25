#!/usr/bin/env node
import { parseArguments } from "../presentation/cli.js";
import { TerminalProgress } from "../presentation/progress.js";
import { formatInvocation } from "../presentation/invocation.js";
import { runTasks } from "./run.js";
import { CommandFailedError } from "../domain/execution-errors.js";

const controller = new AbortController();
let exitCode = 1;
const interrupt = (): void => {
  exitCode = 130;
  controller.abort(new Error("Interrupted"));
};
const terminate = (): void => {
  exitCode = 143;
  controller.abort(new Error("Terminated"));
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
  const input = parseArguments(process.argv.slice(2));
  if (input.help) {
    console.log(
      "task-runner run <entrypoint> [--config path] [--package path] [--ci] [--concurrency n] [--collapse true|false] [--max-tasks n] [--no-scroll]",
    );
  } else {
    const progress = new TerminalProgress(
      process.stderr,
      process.stderr.isTTY === true &&
        !process.env["CI"] &&
        input.options.ci !== true &&
        process.env["TERM"] !== "dumb",
      input.options.collapse,
      input.options.maxTasks,
      input.options.scroll === true && process.stdin.isTTY === true
        ? {
            input: process.stdin,
            onInterrupt: interrupt,
            command: formatInvocation(process.argv.slice(2), process.env),
          }
        : undefined,
    );
    let result;
    try {
      result = await runTasks(input.entrypoint, {
        ...input.options,
        signal: controller.signal,
        onPlan: (graph, target) => progress.start(graph, target),
        onEvent: (event) => progress.update(event),
      });
    } finally {
      progress.stop();
    }
    process.exitCode = result.success ? 0 : exitCode;
    for (const error of result.errors)
      console.error(
        error instanceof CommandFailedError ? error.message : error,
      );
    console.error(`${progress.summary()}\n`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = exitCode;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
}
