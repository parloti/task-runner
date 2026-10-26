import { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { make } from "ts-brand";
import { describe, expect, it, vi } from "vitest";

import type { CompiledTask, TaskId } from "../../domain";

import { createProcessExecutor } from "../process";
import { mockSpawn } from "./process-test-helpers";

const task: CompiledTask = {
  dependsOn: [],
  id: make<TaskId>()("command"),
  package: ".",
  run: { command: `node -e "setTimeout(()=>{},30)"`, kind: "shell" },
  skip: false,
};

/**
 * Registers process termination tests for the process boundary suite.
 * @example
 * ```ts
 * registerProcessTerminationTests();
 * ```
 */
export function registerProcessTerminationTests(): void {
  describe("process termination", () => {
    it.each(["ESRCH", "EPERM"])(
      "checks OS process existence after a failed taskkill: %s",
      async (code) => {
        const directory = mkdtempSync(
          path.join(os.tmpdir(), "runner-process-"),
        );
        const kill = vi.fn<
          (pid: number, signal: NodeJS.Signals | number) => boolean
        >(() => {
          throw Object.assign(new Error(`kill ${code}`), { code });
        });
        vi.stubGlobal("process", { ...process, kill, platform: "win32" });
        vi.mocked(spawn).mockImplementation((file, args, options) => {
          if (file !== "taskkill")
            return mockSpawn(file, args, options, 12_345);
          const killer = new ChildProcess();
          queueMicrotask(() => killer.emit("close", 1));
          return killer;
        });
        const executor = createProcessExecutor(directory, directory, false);
        const controller = new AbortController();
        try {
          const execution = executor(task, controller.signal);
          controller.abort(new Error("cancel"));
          // Assert
          await expect(execution).rejects.toThrow(
            code === "ESRCH" ? "Cancelled task" : "Task and cleanup failed",
          );
          expect(kill).toHaveBeenCalledWith(expect.any(Number), 0);
        } finally {
          rmSync(directory, { force: true, recursive: true });
        }
      },
    );

    it.each(["ok", "gone", "denied"])(
      "uses POSIX group escalation and preserves cleanup errors: %s",
      async (mode) => {
        const directory = mkdtempSync(
          path.join(os.tmpdir(), "runner-process-"),
        );
        const original = process;
        const kill = vi.fn<
          (pid: number, signal: NodeJS.Signals | number) => boolean
        >(() => {
          if (mode !== "ok")
            throw Object.assign(new Error(mode), {
              code: mode === "gone" ? "ESRCH" : "EPERM",
            });
          return true;
        });
        vi.stubGlobal("process", { ...original, kill, platform: "linux" });
        vi.mocked(spawn).mockImplementation((file, args, options) =>
          mockSpawn(file, args, options, 12_345),
        );
        const executor = createProcessExecutor(directory, directory, false);
        const controller = new AbortController();
        try {
          const execution = executor(task, controller.signal);
          controller.abort(new Error("cancel"));
          await expect(execution).rejects.toThrow(
            mode === "denied" ? "Task and cleanup failed" : "Cancelled task",
          );
          expect(kill).toHaveBeenCalledWith(expect.any(Number), "SIGTERM");
          const signals = kill.mock.calls.map(([, signal]) => signal);
          expect(signals.includes("SIGKILL")).toBe(mode !== "denied");
        } finally {
          rmSync(directory, { force: true, recursive: true });
        }
      },
    );
  });
}
