import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
  it("preserves unexpected executor errors instead of presenting them as ordinary command failures", async () => {
    // Arrange
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "runner-cli-unexpected-"),
    );
    writeFileSync(path.join(directory, "package.json"), "{}");
    const config = path.join(directory, "task-runner.json");
    writeFileSync(
      config,
      JSON.stringify({
        version: 2,
        packages: {
          ".": { check: { run: { kind: "shell", command: "unused" } } },
        },
      }),
    );
    const failure = new Error("owned process cleanup failed");
    vi.resetModules();
    vi.doMock(import("../infrastructure/process.js"), () => ({
      createProcessExecutor: () => async () => {
        throw failure;
      },
      findNpmCli: vi.fn(),
    }));
    process.argv = [
      "node",
      "task-runner",
      "check",
      "--config",
      config,
      "--package",
      ".",
    ];
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      // Act
      await import("./cli.js");
      // Assert
      expect(process.exitCode).toBe(1);
      expect(error.mock.calls).toEqual([[failure], ["Tasks: 1 | failed: 1\n"]]);
    } finally {
      vi.doUnmock(import("../infrastructure/process.js"));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each(["success", "failure", "interrupt", "after-plan"] as const)(
    "wires scroll input and restores the screen before diagnostics: %s",
    async (outcome) => {
      // Arrange
      const directory = mkdtempSync(
        path.join(os.tmpdir(), "runner-cli-scroll-"),
      );
      writeFileSync(path.join(directory, "package.json"), "{}");
      const config = path.join(directory, "task-runner.json");
      writeFileSync(
        config,
        JSON.stringify({
          version: 2,
          packages: {
            ".": {
              check: {
                run: {
                  kind: "shell",
                  command: `node -e "process.exitCode=${outcome === "failure" ? 7 : 0}"`,
                },
              },
            },
          },
        }),
      );
      if (outcome === "after-plan")
        writeFileSync(path.join(directory, "logs"), "not a directory");
      const properties = [
        [process.stdin, "isTTY"],
        [process.stdin, "isRaw"],
        [process.stdin, "setRawMode"],
        [process.stderr, "isTTY"],
      ] as const;
      const descriptors = properties.map(([stream, property]) =>
        Object.getOwnPropertyDescriptor(stream, property),
      );
      const raw = vi.fn();
      for (const [stream, property] of properties)
        Object.defineProperty(stream, property, {
          configurable: true,
          value: property === "setRawMode" ? raw : property === "isTTY",
        });
      vi.spyOn(process.stdin, "resume").mockReturnThis();
      vi.spyOn(process.stdin, "pause").mockReturnThis();
      const originalDataListeners = process.stdin.listeners("data");
      const originalResizeListeners = process.stderr.listeners("resize");
      vi.stubEnv("CI", "");
      vi.stubEnv("TERM", "xterm");
      vi.stubEnv("npm_command", "run-script");
      vi.stubEnv("npm_lifecycle_event", "check");
      vi.stubEnv("npm_lifecycle_script", "task-runner check");
      vi.resetModules();
      process.argv = [
        "node",
        "task-runner",
        "check",
        "--config",
        config,
        "--package",
        ".",
        "--scroll",
      ];
      const output = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((message) => {
          if (outcome === "interrupt" && String(message).includes("(running"))
            process.stdin.emit("data", Buffer.from("\u0003"));
          return true;
        });
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        // Act
        await import("./cli.js");
        // Assert
        expect(process.exitCode).toBe(
          outcome === "success" ? 0 : outcome === "interrupt" ? 130 : 1,
        );
        expect(raw.mock.calls).toEqual([[true], [false]]);
        const calls = output.mock.calls.map(([message]) => String(message));
        expect(calls[0]).toContain("\u001b[?1049h");
        const restore = calls.findIndex((message) =>
          message.includes("\u001b[?1049l"),
        );
        expect(restore).toBeGreaterThan(0);
        expect(calls.slice(0, restore).join("")).toContain("npm run check --");
        expect(calls.slice(restore + 1).join("")).not.toContain(
          "npm run check --",
        );
        expect(calls.slice(restore + 1).join("")).toContain("check (");
        if (outcome === "failure" || outcome === "after-plan")
          expect(output.mock.invocationCallOrder[restore]).toBeLessThan(
            error.mock.invocationCallOrder[0]!,
          );
        if (outcome === "after-plan") {
          expect(error).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
        } else {
          const status =
            outcome === "success"
              ? "succeeded"
              : outcome === "failure"
                ? "failed"
                : "cancelled";
          expect(error).toHaveBeenLastCalledWith(`Tasks: 1 | ${status}: 1\n`);
          expect(error).toHaveBeenCalledTimes(outcome === "failure" ? 2 : 1);
          expect(output.mock.invocationCallOrder[restore]).toBeLessThan(
            error.mock.invocationCallOrder.at(-1)!,
          );
        }
        expect(process.stdin.listeners("data")).toEqual(originalDataListeners);
        expect(process.stderr.listeners("resize")).toEqual(
          originalResizeListeners,
        );
      } finally {
        properties.forEach(([stream, property], index) => {
          const descriptor = descriptors[index];
          if (descriptor === undefined)
            Reflect.deleteProperty(stream, property);
          else Object.defineProperty(stream, property, descriptor);
        });
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it.each([
    { tty: true, ci: "", term: "xterm", args: [], live: true },
    { tty: false, ci: "", term: "xterm", args: [], live: false },
    { tty: true, ci: "1", term: "xterm", args: [], live: false },
    { tty: true, ci: "", term: "xterm", args: ["--ci"], live: false },
    { tty: true, ci: "", term: "dumb", args: [], live: false },
  ])(
    "selects live=$live with TTY=$tty, CI=$ci, TERM=$term and args=$args",
    async ({ tty, ci, term, args, live }) => {
      // Arrange
      const directory = mkdtempSync(path.join(os.tmpdir(), "runner-display-"));
      writeFileSync(path.join(directory, "package.json"), "{}");
      const config = path.join(directory, "task-runner.json");
      writeFileSync(
        config,
        JSON.stringify({ version: 2, packages: { ".": { check: {} } } }),
      );
      const descriptor = Object.getOwnPropertyDescriptor(
        process.stderr,
        "isTTY",
      );
      Object.defineProperty(process.stderr, "isTTY", {
        configurable: true,
        value: tty,
      });
      vi.stubEnv("CI", ci);
      vi.stubEnv("TERM", term);
      vi.resetModules();
      process.argv = [
        "node",
        "task-runner",
        "check",
        "--config",
        config,
        "--package",
        ".",
        ...args,
        "--no-scroll",
      ];
      const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const timer = vi.spyOn(globalThis, "setInterval");
      const cleanup = vi.spyOn(globalThis, "clearInterval");
      try {
        // Act
        await import("./cli.js");
        // Assert
        expect(process.exitCode).toBe(0);
        expect(
          output.mock.calls.map(([text]) => String(text)).join(""),
        ).toContain("(succeeded");
        expect(timer).toHaveBeenCalledTimes(live ? 1 : 0);
        expect(cleanup).toHaveBeenCalledWith(
          live ? timer.mock.results[0]!.value : undefined,
        );
        expect(
          output.mock.calls.some(([text]) => String(text).includes("\u001b[")),
        ).toBe(live);
      } finally {
        if (descriptor === undefined)
          Reflect.deleteProperty(process.stderr, "isTTY");
        else Object.defineProperty(process.stderr, "isTTY", descriptor);
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
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
          : JSON.stringify({ version: 2, packages: { ".": { check: {} } } }),
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
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
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
          failure === "after-plan" ? timer.mock.results[0]!.value : undefined,
        );
        expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
          error.mock.invocationCallOrder[0]!,
        );
      } finally {
        if (descriptor === undefined)
          Reflect.deleteProperty(process.stderr, "isTTY");
        else Object.defineProperty(process.stderr, "isTTY", descriptor);
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it.each([
    { signal: "SIGINT", code: 130 },
    { signal: "SIGTERM", code: 143 },
  ])(
    "handles $signal without leaving global signal listeners",
    async ({ signal, code }) => {
      // Arrange
      const directory = mkdtempSync(
        path.join(os.tmpdir(), "runner-cli-signal-"),
      );
      writeFileSync(path.join(directory, "package.json"), "{}");
      const config = path.join(directory, "task-runner.json");
      writeFileSync(
        config,
        JSON.stringify({
          version: 2,
          packages: {
            ".": {
              check: {
                run: { kind: "shell", command: `node -e "process.exitCode=0"` },
              },
            },
          },
        }),
      );
      vi.resetModules();
      const listeners: Record<string, () => void> = {};
      const register = process.on.bind(process);
      vi.spyOn(process, "on").mockImplementation((event, listener) => {
        if (event === "SIGINT" || event === "SIGTERM") {
          listeners[event] = () => listener();
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
        rmSync(directory, { recursive: true, force: true });
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
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
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
          version: 2,
          packages: {
            ".": {
              check: {
                run: {
                  kind: "shell",
                  command: `node -e "process.exitCode=${String(code)}"`,
                },
              },
            },
          },
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
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        // Act
        await import("./cli.js");
        // Assert
        expect(process.exitCode).toBe(code === 0 ? 0 : 1);
        expect(output).toHaveBeenCalledWith(
          expect.stringContaining(code === 0 ? "(succeeded" : "(failed"),
        );
        if (code !== 0) {
          expect(error).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining("Command failed (7): check\nLog: logs"),
          );
          expect(error.mock.calls.flat().join("")).not.toContain("at file:");
        }
        expect(error).toHaveBeenLastCalledWith(
          `Tasks: 1 | ${code === 0 ? "succeeded" : "failed"}: 1\n`,
        );
        expect(error).toHaveBeenCalledTimes(code === 0 ? 1 : 2);
      } finally {
        vi.unstubAllEnvs();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
