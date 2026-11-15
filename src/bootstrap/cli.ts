#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { CommandFailedError } from "../domain";
import { findConfiguration, parseConfiguration } from "../infrastructure";
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
  const args = process.argv.slice(2);
  const input = parseArguments(args);
  if (input.help) {
    console.log(
      "task-runner run <entrypoint> [--config path] [--package path] [--ci] [--concurrency n] [--collapse true|false] [--max-tasks n] [--no-scroll] [--no-cache]",
    );
  } else {
    const configPath = findConfiguration(process.cwd(), input.options.config);
    const config = parseConfiguration(
      JSON.parse(readFileSync(configPath, "utf8")) as unknown,
    );
    const scrollWasSpecified =
      args.includes("--scroll") || args.includes("--no-scroll");
    const settings = {
      ...config.defaults,
      ...input.options,
      scroll: scrollWasSpecified
        ? input.options.scroll
        : (config.defaults?.scroll ?? true),
    };
    const progress = new TerminalProgress(
      process.stderr,
      process.stderr.isTTY &&
        !process.env["CI"] &&
        settings.ci !== true &&
        process.env["TERM"] !== "dumb",
      settings.collapse,
      settings.maxTasks,
      settings.scroll && process.stdin.isTTY
        ? {
            command: formatInvocation(process.argv.slice(2), process.env),
            input: process.stdin,
            onInterrupt: interrupt,
          }
        : undefined,
    );
    let result;
    let finishedAt: string;
    try {
      result = await runTasks(input.entrypoint, {
        ...input.options,
        onEvent: (event) => {
          progress.update(event);
        },
        onPlan: (graph, target, packagePaths) => {
          progress.start(graph, target, packagePaths);
        },
        signal: controller.signal,
      });
      finishedAt = new Date().toISOString();
    } finally {
      progress.stop();
    }
    process.exitCode = cliExitCode(result.success, controller.signal.reason);
    for (const error of result.errors)
      console.error(
        error instanceof CommandFailedError ? error.message : error,
      );
    console.error(`${progress.summary()} | Finished at: ${finishedAt}\n`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = cliExitCode(false, controller.signal.reason);
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
}
