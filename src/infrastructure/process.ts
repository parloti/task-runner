import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { stripVTControlCharacters } from "node:util";

import type { ExecuteCommand } from "../domain";

import { CommandFailedError, TaskCancelledError, taskName } from "../domain";
import { taskLogPath } from "./task-log";

/**
 * Create an adapter that runs command tasks and manages their output logs.
 * @param root Absolute project root used as the package path base.
 * @param runDirectory Directory for per-task output logs.
 * @param ci Whether output streams directly to the terminal.
 * @returns Command executor for the application scheduler.
 * @example `createProcessExecutor(root, logs, false)` captures output in task logs.
 */
export function createProcessExecutor(
  root: string,
  runDirectory: string,
  ci: boolean,
): ExecuteCommand {
  return async (task, signal) => {
    if (isAborted(signal)) throw new TaskCancelledError(taskName(task));
    const command = task.run;
    if (command === undefined) throw new Error(`Missing command: ${task.id}`);
    const file = command.kind === "npm" ? process.execPath : command.command;
    const args =
      command.kind === "npm"
        ? [
            findNpmCli(),
            "run",
            command.script,
            ...(command.args?.length ? ["--", ...command.args] : []),
          ]
        : [];
    const logPath = taskLogPath(runDirectory, task);
    const label = stripVTControlCharacters(
      task.package === "."
        ? taskName(task)
        : `${task.package} > ${taskName(task)}`,
    ).replaceAll(/[\p{Cc}\p{Cf}]/gu, " ");
    const child = spawn(file, args, {
      cwd: path.resolve(root, task.package),
      detached: process.platform !== "win32",
      shell: command.kind === "shell",
      stdio: ["ignore", ci ? "inherit" : "pipe", ci ? "inherit" : "pipe"],
      windowsHide: true,
    });
    const log = ci ? undefined : createWriteStream(logPath, { flags: "wx" });
    let termination: Promise<void> | undefined;
    const cancel = (): void => {
      termination ??= terminate(child);
      // Keep cancellation rejection observed until the main cleanup awaits it.
      void termination.catch(() => false);
    };
    signal.addEventListener("abort", cancel, { once: true });
    const closed = new Promise<null | number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        log?.end();
        resolve(code);
      });
    });
    if (log !== undefined) {
      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
    }
    const streamDone = log === undefined ? Promise.resolve() : finished(log);
    try {
      const [code] = await Promise.all([closed, streamDone]);
      if (isAborted(signal)) throw new TaskCancelledError(label);
      if (code !== 0)
        throw new CommandFailedError(
          label,
          code,
          ci ? undefined : path.relative(root, logPath),
        );
      if (!ci) rmSync(logPath);
    } catch (error) {
      cancel();
      log?.destroy();
      await Promise.allSettled([closed, streamDone]);
      try {
        await termination;
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Task and cleanup failed: ${task.id}`,
          { cause: cleanupError },
        );
      }
      if (!ci && error instanceof TaskCancelledError) rmSync(logPath);
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  };
}

/**
 * Find the npm CLI script associated with the selected Node runtime.
 * @param runtime Process environment and executable path used for discovery.
 * @returns Absolute path to `npm-cli.js`.
 * @example `findNpmCli(process)` uses npm's active runtime environment.
 */
function findNpmCli(
  runtime: Pick<NodeJS.Process, "env" | "execPath"> = process,
): string {
  const candidates = [
    runtime.env["npm_execpath"],
    ...[
      path.dirname(runtime.execPath),
      ...(runtime.env["PATH"] ?? "")
        .split(path.delimiter)
        .filter((directory) => directory.length > 0),
    ].map((directory) =>
      path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    ),
  ];
  const found = candidates.find(
    (candidate) => candidate?.endsWith("npm-cli.js") && existsSync(candidate),
  );
  if (found === undefined)
    throw new Error(
      "Cannot locate npm-cli.js; launch through npm or install npm alongside Node.js",
    );
  return found;
}

/**
 * Check whether cancellation has reached the owned command.
 * @param signal Abort signal attached to the command execution.
 * @returns Whether the signal has been aborted.
 * @example `isAborted(signal)` checks for a pending cancellation.
 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Terminate an owned child process and wait for its exit.
 * @param child Child process created by this executor.
 * @example `await terminate(child)` cleans up the owned command process.
 */
async function terminate(child: ChildProcess): Promise<void> {
  const { pid } = child;
  const hasExited = (): boolean =>
    child.exitCode !== null || child.signalCode !== null;
  if (pid === undefined || hasExited()) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const code = await new Promise<null | number>((resolve, reject) => {
      killer.once("error", reject);
      killer.once("close", resolve);
    });
    if (code === 0 || hasExited()) return;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return;
      throw error;
    }
    throw new Error(
      `Cannot terminate owned process tree ${String(pid)} (taskkill ${String(code)})`,
    );
  }
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
  };
  signalGroup("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  signalGroup("SIGKILL");
}
