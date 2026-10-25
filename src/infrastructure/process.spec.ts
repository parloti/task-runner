import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { make } from "ts-brand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompiledTask, TaskId } from "../domain/types.js";
import { createProcessExecutor, findNpmCli } from "./process.js";

const task: CompiledTask = {
  id: make<TaskId>()("command"),
  package: ".",
  dependsOn: [],
  skip: false,
  run: { kind: "shell", command: `node -e "setTimeout(()=>{},30)"` },
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
      // Arrange
      const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
      const child = new ChildProcess();
      Object.defineProperties(child, {
        pid: { value: 12345 },
        exitCode: { value: mode === "exit" ? 2 : null },
        signalCode: { value: mode === "signal" ? "SIGTERM" : null },
      });
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
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it("does not leak a log stream when spawning throws synchronously", async () => {
    // Arrange
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
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("locates npm through its environment or Node installation and fails clearly when unavailable", () => {
    // Arrange
    // Act & Assert
    expect(findNpmCli()).toMatch(/npm-cli\.js$/);
    expect(() =>
      findNpmCli({
        execPath: "C:\\not-installed\\node.exe",
        env: { PATH: undefined, npm_execpath: undefined },
      }),
    ).toThrow("Cannot locate npm");
  });

  it("does not spawn after cancellation and rejects tasks without commands", async () => {
    // Arrange
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
        id: task.id,
        package: ".",
        dependsOn: [],
        skip: false,
      };
      await expect(
        executor(empty, new AbortController().signal),
      ).rejects.toThrow("Missing command");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "reports spawn errors and closes resources in CI=%s",
    async (ci) => {
      // Arrange
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
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("streams successful and failed CI commands without opening output logs", async () => {
    // Arrange
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
            run: { kind: "shell", command: `node -e "process.exitCode=2"` },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("Command failed (2)");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("surfaces log IO failures and cleans up the command", async () => {
    // Arrange
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
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports owned-tree termination failures instead of hiding them", async () => {
    // Arrange
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
      // Act
      const execution = executor(task, controller.signal);
      controller.abort(new Error("cancel"));
      // Assert
      await expect(execution).rejects.toThrow("Task and cleanup failed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["ESRCH", "EPERM"])(
    "checks OS process existence after a failed taskkill: %s",
    async (code) => {
      // Arrange
      const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
      const kill = vi.fn(() => {
        throw Object.assign(new Error(`kill ${code}`), { code });
      });
      vi.stubGlobal("process", { ...process, platform: "win32", kill });
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
        // Act
        const execution = executor(task, controller.signal);
        controller.abort(new Error("cancel"));
        // Assert
        await expect(execution).rejects.toThrow(
          code === "ESRCH" ? "Cancelled task" : "Task and cleanup failed",
        );
        expect(kill).toHaveBeenCalledWith(expect.any(Number), 0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    "cancels owned Windows commands and waits for closure in CI=%s",
    async (ci) => {
      // Arrange
      const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
      const executor = createProcessExecutor(directory, directory, ci);
      const controller = new AbortController();
      try {
        // Act
        const execution = executor(task, controller.signal);
        controller.abort(new Error("cancel"));
        // Assert
        await expect(execution).rejects.toThrow("Cancelled task");
        expect(readdirSync(directory)).toEqual([]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["ok", "gone", "denied"])(
    "uses POSIX group escalation and preserves cleanup errors: %s",
    async (mode) => {
      // Arrange
      const directory = mkdtempSync(path.join(os.tmpdir(), "runner-process-"));
      const original = process;
      const kill = vi.fn(() => {
        if (mode !== "ok")
          throw Object.assign(new Error(mode), {
            code: mode === "gone" ? "ESRCH" : "EPERM",
          });
        return true;
      });
      vi.stubGlobal("process", { ...original, platform: "linux", kill });
      const executor = createProcessExecutor(directory, directory, false);
      const controller = new AbortController();
      try {
        // Act
        const execution = executor(task, controller.signal);
        controller.abort(new Error("cancel"));
        // Assert
        await expect(execution).rejects.toThrow(
          mode === "denied" ? "Task and cleanup failed" : "Cancelled task",
        );
        expect(kill).toHaveBeenCalledWith(expect.any(Number), "SIGTERM");
        if (mode !== "denied")
          expect(kill).toHaveBeenCalledWith(expect.any(Number), "SIGKILL");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
import { ChildProcess, spawn } from "node:child_process";
