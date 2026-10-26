import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalArgs = process.argv;
const originalExitCode = process.exitCode;
const unexpectedExecutorError = new Error("owned process cleanup failed");
const rejectUnexpectedExecutorError = (): Promise<never> =>
  Promise.reject(unexpectedExecutorError);
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
        packages: {
          ".": { check: { run: { command: "unused", kind: "shell" } } },
        },
        version: 2,
      }),
    );
    vi.resetModules();
    vi.doMock(import("../infrastructure"), async (importOriginal) => ({
      ...(await importOriginal()),
      createProcessExecutor: () => rejectUnexpectedExecutorError,
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
    const error = vi.spyOn(console, "error").mockImplementation(vi.fn());
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      // Act
      await import("./cli.js");
      // Assert
      expect(process.exitCode).toBe(1);
      expect(error.mock.calls).toEqual([
        [unexpectedExecutorError],
        ["Tasks: 1 | failed: 1\n"],
      ]);
    } finally {
      vi.doUnmock(import("../infrastructure"));
      rmSync(directory, { force: true, recursive: true });
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
          packages: {
            ".": {
              check: {
                run: {
                  command: `node -e "process.exitCode=${String(outcome === "failure" ? 7 : 0)}"`,
                  kind: "shell",
                },
              },
            },
          },
          version: 2,
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
            process.stdin.emit("data", Buffer.from("\u{3}"));
          return true;
        });
      const error = vi.spyOn(console, "error").mockImplementation(vi.fn());
      try {
        // Act
        await import("./cli.js");
        // Assert
        expect(process.exitCode).toBe(
          outcome === "success" ? 0 : outcome === "interrupt" ? 130 : 1,
        );
        expect(raw.mock.calls).toEqual([[true], [false]]);
        const calls = output.mock.calls.map(([message]) => String(message));
        expect(calls[0]).toContain("\u{1B}[?1049h");
        const restore = calls.findIndex((message) =>
          message.includes("\u{1B}[?1049l"),
        );
        expect(restore).toBeGreaterThan(0);
        expect(calls.slice(0, restore).join("")).toContain("npm run check --");
        expect(calls.slice(restore + 1).join("")).not.toContain(
          "npm run check --",
        );
        expect(calls.slice(restore + 1).join("")).toContain("check (");
        const status =
          outcome === "success"
            ? "succeeded"
            : outcome === "failure"
              ? "failed"
              : "cancelled";
        const firstErrorOrder = error.mock.invocationCallOrder.at(0) ?? 0;
        const lastErrorOrder = error.mock.invocationCallOrder.at(-1) ?? 0;
        const restoreOrder =
          output.mock.invocationCallOrder[restore] ?? Number.MAX_SAFE_INTEGER;
        expect(restoreOrder).toBeLessThan(firstErrorOrder);
        expect(restoreOrder).toBeLessThan(lastErrorOrder);
        const lastError: unknown = error.mock.calls.at(-1)?.[0];
        const expectedLastError =
          outcome === "after-plan"
            ? lastError instanceof Error
            : lastError === `Tasks: 1 | ${status}: 1\n`;
        expect(expectedLastError).toBe(true);
        expect(error).toHaveBeenCalledTimes(outcome === "failure" ? 2 : 1);
        expect(process.stdin.listeners("data")).toEqual(originalDataListeners);
        expect(process.stderr.listeners("resize")).toEqual(
          originalResizeListeners,
        );
      } finally {
        for (const [index, [stream, property]] of properties.entries()) {
          const descriptor = descriptors[index];
          if (descriptor === undefined)
            Reflect.deleteProperty(stream, property);
          else Object.defineProperty(stream, property, descriptor);
        }
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
  it.each([
    { args: [], ci: "", live: true, term: "xterm", tty: true },
    { args: [], ci: "", live: false, term: "xterm", tty: false },
    { args: [], ci: "1", live: false, term: "xterm", tty: true },
    { args: ["--ci"], ci: "", live: false, term: "xterm", tty: true },
    { args: [], ci: "", live: false, term: "dumb", tty: true },
  ])(
    "selects live=$live with TTY=$tty, CI=$ci, TERM=$term and args=$args",
    async ({ args, ci, live, term, tty }) => {
      // Arrange
      const directory = mkdtempSync(path.join(os.tmpdir(), "runner-display-"));
      writeFileSync(path.join(directory, "package.json"), "{}");
      const config = path.join(directory, "task-runner.json");
      writeFileSync(
        config,
        JSON.stringify({ packages: { ".": { check: {} } }, version: 2 }),
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
          live ? timer.mock.results.at(0)?.value : undefined,
        );
        expect(
          output.mock.calls.some(([text]) => String(text).includes("\u{1B}[")),
        ).toBe(live);
      } finally {
        if (descriptor === undefined)
          Reflect.deleteProperty(process.stderr, "isTTY");
        else Object.defineProperty(process.stderr, "isTTY", descriptor);
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
});
