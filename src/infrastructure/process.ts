import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { stripVTControlCharacters } from "node:util";

import type { ExecuteCommand } from "../domain/types.js";
import {
  CommandFailedError,
  TaskCancelledError,
} from "../domain/execution-errors.js";
import { taskName } from "../domain/task-name.js";
import { taskLogPath } from "./task-log.js";

export function findNpmCli(
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

async function terminate(child: ChildProcess): Promise<void> {
  const { pid } = child;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      killer.once("error", reject);
      killer.once("close", resolve);
    });
    if (code === 0 || child.exitCode !== null || child.signalCode !== null)
      return;
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

export function createProcessExecutor(
  root: string,
  runDirectory: string,
  ci: boolean,
): ExecuteCommand {
  return async (task, signal) => {
    if (signal.aborted) throw new TaskCancelledError(taskName(task));
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
    ).replace(/[\p{Cc}\p{Cf}]/gu, " ");
    const child = spawn(file, args, {
      cwd: path.resolve(root, task.package),
      shell: command.kind === "shell",
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", ci ? "inherit" : "pipe", ci ? "inherit" : "pipe"],
    });
    const log = ci ? undefined : createWriteStream(logPath, { flags: "wx" });
    let termination: Promise<void> | undefined;
    const cancel = (): void => {
      termination ??= terminate(child);
      // Keep cancellation rejection observed until the main cleanup awaits it.
      void termination.catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        log?.end();
        resolve(code);
      });
    });
    child.stdout?.pipe(log!, { end: false });
    child.stderr?.pipe(log!, { end: false });
    const streamDone = log === undefined ? Promise.resolve() : finished(log);
    try {
      const [code] = await Promise.all([closed, streamDone]);
      if (signal.aborted) throw new TaskCancelledError(label);
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
      if (error instanceof TaskCancelledError && !ci) rmSync(logPath);
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  };
}
