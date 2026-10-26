import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalArgs = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgs;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("executable CLI", () => {
  it.each(["preflight", "after-plan"])(
    "cleans up live progress when execution throws %s",
    async (failure) => {
      // Arrange
      const directory = mkdtempSync(
        path.join(os.tmpdir(), "runner-display-error-"),
      );
      writeFileSync(path.join(directory, "package.json"), "{}");
      const config = path.join(directory, "task-runner.json");
      writeFileSync(
        config,
        failure === "preflight"
          ? "invalid json"
          : JSON.stringify({ packages: { ".": { check: {} } }, version: 2 }),
      );
      writeFileSync(path.join(directory, "logs"), "not a directory");
      const descriptor = Object.getOwnPropertyDescriptor(
        process.stderr,
        "isTTY",
      );
      Object.defineProperty(process.stderr, "isTTY", {
        configurable: true,
        value: true,
      });
      vi.stubEnv("CI", "");
      vi.stubEnv("TERM", "xterm");
      vi.resetModules();
      process.argv = [
        "node",
        "task-runner",
        "check",
        "--config",
        config,
        "--package",
        ".",
        "--no-scroll",
      ];
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const error = vi.spyOn(console, "error").mockImplementation(vi.fn());
      const timer = vi.spyOn(globalThis, "setInterval");
      const cleanup = vi.spyOn(globalThis, "clearInterval");
      try {
        // Act
        await import("./cli.js");
        // Assert
        expect(process.exitCode).toBe(1);
        expect(error).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
        expect(timer).toHaveBeenCalledTimes(failure === "after-plan" ? 1 : 0);
        expect(cleanup).toHaveBeenCalledWith(
          failure === "after-plan"
            ? timer.mock.results.at(0)?.value
            : undefined,
        );
        expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
          error.mock.invocationCallOrder[0] ?? 0,
        );
      } finally {
        if (descriptor === undefined)
          Reflect.deleteProperty(process.stderr, "isTTY");
        else Object.defineProperty(process.stderr, "isTTY", descriptor);
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
  it.each([
    { code: 130, signal: "SIGINT" },
    { code: 143, signal: "SIGTERM" },
  ])(
    "handles $signal without leaving global signal listeners",
    async ({ code, signal }) => {
      // Arrange
      const directory = mkdtempSync(
        path.join(os.tmpdir(), "runner-cli-signal-"),
      );
      writeFileSync(path.join(directory, "package.json"), "{}");
      const config = path.join(directory, "task-runner.json");
      writeFileSync(
        config,
        JSON.stringify({
          packages: {
            ".": {
              check: {
                run: { command: `node -e "process.exitCode=0"`, kind: "shell" },
              },
            },
          },
          version: 2,
        }),
      );
      vi.resetModules();
      const listeners: Record<string, () => void> = {};
      const register = process.on.bind(process);
      vi.spyOn(process, "on").mockImplementation((event, listener) => {
        if (event === "SIGINT" || event === "SIGTERM") {
          listeners[event] = () => {
            listener();
          };
          return process;
        }
        return register(event, listener);
      });
      process.argv = [
        "node",
        "task-runner",
        "check",
        "--config",
        config,
        "--package",
        ".",
      ];
      vi.spyOn(process.stderr, "write").mockImplementation((message) => {
        if (String(message).includes("(running")) listeners[signal]?.();
        return true;
      });
      try {
        // Act
        await import("./cli.js");
        // Assert
        expect(process.exitCode).toBe(code);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
  it.each([
    { args: ["--help"], expected: undefined },
    { args: [], expected: 1 },
  ])(
    "handles help and invalid input without starting tasks",
    async ({ args, expected }) => {
      // Arrange
      vi.resetModules();
      process.exitCode = undefined;
      process.argv = ["node", "task-runner", ...args];
      vi.spyOn(console, "log").mockImplementation(vi.fn());
      vi.spyOn(console, "error").mockImplementation(vi.fn());
      // Act
      await import("./cli.js");
      // Assert
      expect(process.exitCode).toBe(expected);
    },
  );

  it.each([0, 7])(
    "returns the real task outcome for command exit %i",
    async (code) => {
      // Arrange
      const directory = mkdtempSync(path.join(os.tmpdir(), "runner-cli-"));
      writeFileSync(path.join(directory, "package.json"), '{"name":"fixture"}');
      const config = path.join(directory, "task-runner.json");
      writeFileSync(
        config,
        JSON.stringify({
          packages: {
            ".": {
              check: {
                run: {
                  command: `node -e "process.exitCode=${String(code)}"`,
                  kind: "shell",
                },
              },
            },
          },
          version: 2,
        }),
      );
      vi.resetModules();
      vi.stubEnv("CI", "");
      process.argv = [
        "node",
        "task-runner",
        "check",
        "--config",
        config,
        "--package",
        ".",
      ];
      const error = vi.spyOn(console, "error").mockImplementation(vi.fn());
      const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        // Act
        await import("./cli.js");
        // Assert
        expect(process.exitCode).toBe(code === 0 ? 0 : 1);
        expect(output).toHaveBeenCalledWith(
          expect.stringContaining(code === 0 ? "(succeeded" : "(failed"),
        );
        const errorOutput = error.mock.calls.flat().join("");
        expect(
          errorOutput.includes("Command failed (7): check\nLog: logs"),
        ).toBe(code !== 0);
        expect(errorOutput).not.toContain("at file:");
        expect(error).toHaveBeenLastCalledWith(
          `Tasks: 1 | ${code === 0 ? "succeeded" : "failed"}: 1\n`,
        );
        expect(error).toHaveBeenCalledTimes(code === 0 ? 1 : 2);
      } finally {
        vi.unstubAllEnvs();
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
});
