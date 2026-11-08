import { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
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
    it.each([
      { ci: false, mode: "spawn" },
      { ci: true, mode: "spawn" },
      { ci: false, mode: "exit" },
      { ci: true, mode: "exit" },
    ])(
      "reports a failed termination without waiting for a running child: $mode, CI=$ci",
      async ({ ci, mode }) => {
        const directory = mkdtempSync(
          path.join(os.tmpdir(), "runner-process-"),
        );
        const child = new ChildProcess();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const unref = vi.spyOn(child, "unref");
        Object.defineProperties(child, {
          pid: { value: 12_345 },
          stderr: { value: stderr },
          stdout: { value: stdout },
        });
        vi.stubGlobal("process", {
          ...process,
          kill: vi.fn(() => true),
          platform: "win32",
        });
        vi.mocked(spawn).mockImplementation((file) => {
          if (file !== "taskkill") return child;
          const killer = new ChildProcess();
          queueMicrotask(() => {
            if (mode === "spawn") {
              killer.emit("error", new Error("taskkill failed"));
            } else {
              killer.emit("close", 1);
            }
          });
          return killer;
        });
        const executor = createProcessExecutor(directory, directory, ci);
        const controller = new AbortController();
        try {
          const execution = executor(task, controller.signal);
          controller.abort(new Error("cancel"));
          await expect(execution).rejects.toThrow(
            "Task and cleanup failed: command",
          );
          await expect(execution).rejects.toHaveProperty(
            "cause",
            new Error(
              mode === "spawn"
                ? "taskkill failed"
                : "Cannot terminate owned process tree 12345 (taskkill 1)",
            ),
          );
          await expect(execution).rejects.toHaveProperty(
            "errors.0.message",
            "Cancelled task: command",
          );
          expect(unref).toHaveBeenCalledOnce();
          expect(stdout.destroyed).toBe(true);
          expect(stderr.destroyed).toBe(true);
        } finally {
          rmSync(directory, { force: true, recursive: true });
        }
      },
    );

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
