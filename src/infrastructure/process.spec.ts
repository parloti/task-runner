import { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { make } from "ts-brand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompiledTask, TaskId } from "../domain";

import { createProcessExecutor } from "./process";

const task: CompiledTask = {
  dependsOn: [],
  id: make<TaskId>()("command"),
  package: ".",
  run: { command: `node -e "setTimeout(()=>{},30)"`, kind: "shell" },
  skip: false,
};
vi.mock(import("node:child_process"), async (importOriginal) => {
  const actual = { ...(await importOriginal()) };
  return { ...actual, spawn: vi.fn().mockImplementation(actual.spawn) };
});
beforeEach(async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  vi.mocked(spawn).mockImplementation(actual.spawn);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(spawn).mockReset();
});

describe("process boundary", () => {
  it.each(["exit", "signal"] as const)(
    "does not signal a PID after observing child termination by %s",
    async (mode) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
      const child = new ChildProcess();
      Object.defineProperty(child, "pid", { value: 12_345 });
      if (mode === "exit") {
        Object.defineProperty(child, "exitCode", { value: 2 });
      } else {
        Object.defineProperty(child, "signalCode", { value: "SIGTERM" });
      }
      vi.mocked(spawn)
        .mockImplementation(() => {
          throw new Error("Unexpected termination spawn");
        })
        .mockReturnValueOnce(child);
      const executor = createProcessExecutor(directory, directory, false);
      queueMicrotask(() => child.emit("close", child.exitCode));
      try {
        // Act & Assert
        await expect(
          executor(task, new AbortController().signal),
        ).rejects.toThrow("Command failed");
        expect(spawn).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
  it("does not leak a log stream when spawning throws synchronously", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error("spawn setup failed");
    });
    const executor = createProcessExecutor(directory, directory, false);
    try {
      // Act & Assert
      await expect(
        executor(task, new AbortController().signal),
      ).rejects.toThrow("spawn setup failed");
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
  it("runs npm commands through the discovered npm CLI script", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-npm-cli-"));
    const child = new ChildProcess();
    const npmTask: CompiledTask = {
      ...task,
      run: { kind: "npm", script: "check" },
    };
    vi.mocked(spawn).mockReturnValueOnce(child);
    const executor = createProcessExecutor(directory, directory, false);
    queueMicrotask(() => child.emit("close", 0));
    try {
      await executor(npmTask, new AbortController().signal);
      // Assert
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([
          expect.stringMatching(/npm-cli\.js$/),
          "run",
          "check",
        ]),
        expect.any(Object),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not spawn after cancellation and rejects tasks without commands", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
    const executor = createProcessExecutor(directory, directory, false);
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    try {
      // Act & Assert
      await expect(executor(task, controller.signal)).rejects.toThrow(
        "Cancelled task",
      );
      const empty: CompiledTask = {
        dependsOn: [],
        id: task.id,
        package: ".",
        skip: false,
      };
      await expect(
        executor(empty, new AbortController().signal),
      ).rejects.toThrow("Missing command");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([false, true])(
    "reports spawn errors and closes resources in CI=%s",
    async (ci) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
      const executor = createProcessExecutor(directory, directory, ci);
      try {
        // Act & Assert
        await expect(
          executor(
            { ...task, package: "absent" },
            new AbortController().signal,
          ),
        ).rejects.toThrow("ENOENT");
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it("streams successful and failed CI commands without opening output logs", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
    const executor = createProcessExecutor(directory, directory, true);
    try {
      // Act & Assert
      await expect(
        executor(task, new AbortController().signal),
      ).resolves.toBeUndefined();
      await expect(
        executor(
          {
            ...task,
            run: { command: `node -e "process.exitCode=2"`, kind: "shell" },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("Command failed (2)");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("surfaces log IO failures and cleans up the command", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
    const executor = createProcessExecutor(
      directory,
      path.join(directory, "absent"),
      false,
    );
    try {
      // Act & Assert
      await expect(
        executor(task, new AbortController().signal),
      ).rejects.toThrow("ENOENT");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reports owned-tree termination failures instead of hiding them", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const { spawn: normal } =
      await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
    vi.mocked(spawn).mockImplementation((file, args, options) => {
      if (file !== "taskkill") return normal(file, args, options);
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
      await expect(execution).rejects.toThrow("Task and cleanup failed");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each(["ESRCH", "EPERM"])(
    "checks OS process existence after a failed taskkill: %s",
    async (code) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
      const kill = vi.fn<
        (pid: number, signal: NodeJS.Signals | number) => boolean
      >(() => {
        throw Object.assign(new Error(`kill ${code}`), { code });
      });
      vi.stubGlobal("process", { ...process, kill, platform: "win32" });
      const { spawn: normal } =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process",
        );
      vi.mocked(spawn).mockImplementation((file, args, options) => {
        if (file !== "taskkill") return normal(file, args, options);
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

  it.each([false, true])(
    "cancels owned Windows commands and waits for closure in CI=%s",
    async (ci) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
      const executor = createProcessExecutor(directory, directory, ci);
      const controller = new AbortController();
      try {
        const execution = executor(task, controller.signal);
        controller.abort(new Error("cancel"));
        // Assert
        await expect(execution).rejects.toThrow("Cancelled task");
        expect(readdirSync(directory)).toEqual([]);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it.each(["ok", "gone", "denied"])(
    "uses POSIX group escalation and preserves cleanup errors: %s",
    async (mode) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
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
