#!/usr/bin/env node
import { CommandFailedError } from "../domain";
import {
  formatInvocation,
  parseArguments,
  TerminalProgress,
} from "../presentation";
import { cliExitCode, CliSignalError } from "./cli-errors";
import { runTasks } from "./run";

const controller = new AbortController();
const interrupt = (): void => {
  controller.abort(new CliSignalError(130, "Interrupted"));
};
const terminate = (): void => {
  controller.abort(new CliSignalError(143, "Terminated"));
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
      process.stderr.isTTY &&
        !process.env["CI"] &&
        input.options.ci !== true &&
        process.env["TERM"] !== "dumb",
      input.options.collapse,
      input.options.maxTasks,
      input.options.scroll && process.stdin.isTTY
        ? {
            command: formatInvocation(process.argv.slice(2), process.env),
            input: process.stdin,
            onInterrupt: interrupt,
          }
        : undefined,
    );
    let result;
    try {
      result = await runTasks(input.entrypoint, {
        ...input.options,
        onEvent: (event) => {
          progress.update(event);
        },
        onPlan: (graph, target) => {
          progress.start(graph, target);
        },
        signal: controller.signal,
      });
    } finally {
      progress.stop();
    }
    process.exitCode = cliExitCode(result.success, controller.signal.reason);
    for (const error of result.errors)
      console.error(
        error instanceof CommandFailedError ? error.message : error,
      );
    console.error(`${progress.summary()}\n`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = cliExitCode(false, controller.signal.reason);
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
}
