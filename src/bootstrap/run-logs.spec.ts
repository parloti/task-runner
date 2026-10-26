import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareRunLogDirectory } from "./run-logs";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("run log directory", () => {
  it("clears previous files and unregisters the run when released", async () => {
    // Arrange
    const root = createRoot();
    const logDirectory = path.join(root, "logs", "task-runner");
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(path.join(logDirectory, "old.log"), "previous output");

    // Act
    const run = await prepareRunLogDirectory(root, "current-run");

    // Assert
    expect(run.directory).toBe(logDirectory);
    expect(readdirSync(logDirectory)).toEqual([]);
    expect(
      readFileSync(
        path.join(root, "logs", ".task-runner-active", "current-run.json"),
        "utf8",
      ),
    ).toBe(String(process.pid));
    run.release();
    expect(
      existsSync(
        path.join(root, "logs", ".task-runner-active", "current-run.json"),
      ),
    ).toBe(false);
    expect(existsSync(path.join(root, "logs", ".task-runner-lock"))).toBe(
      false,
    );
  });

  it("keeps files when another invocation is active", async () => {
    // Arrange
    const root = createRoot();
    const logDirectory = path.join(root, "logs", "task-runner");
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(path.join(logDirectory, "old.log"), "retained output");
    const [first, second] = await Promise.all([
      prepareRunLogDirectory(root, "first-run"),
      prepareRunLogDirectory(root, "second-run"),
    ]);
    const activeOutput = path.join(logDirectory, "first-run.log");
    writeFileSync(activeOutput, "active output");

    // Act
    const third = await prepareRunLogDirectory(root, "third-run");

    // Assert
    expect(readdirSync(logDirectory)).toContain("first-run.log");
    expect(readFileSync(activeOutput, "utf8")).toBe("active output");
    first.release();
    second.release();
    third.release();
  });

  it("prunes stale markers and recovers a stale startup lock", async () => {
    // Arrange
    const root = createRoot();
    const logsDirectory = path.join(root, "logs");
    const activeDirectory = path.join(logsDirectory, ".task-runner-active");
    const logDirectory = path.join(logsDirectory, "task-runner");
    mkdirSync(activeDirectory, { recursive: true });
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(path.join(logDirectory, "old.log"), "stale output");
    writeFileSync(path.join(activeDirectory, "stale.json"), "2147483647");
    writeFileSync(path.join(activeDirectory, "partial.json"), "invalid pid");
    writeFileSync(path.join(activeDirectory, "interrupted.tmp"), "partial");
    writeFileSync(
      path.join(logsDirectory, ".task-runner-lock"),
      "2147483647:stale-lock",
    );

    // Act
    const run = await prepareRunLogDirectory(root, "new-run");

    // Assert
    expect(readdirSync(logDirectory)).toEqual([]);
    expect(readdirSync(activeDirectory)).toEqual(["new-run.json"]);
    expect(existsSync(path.join(logsDirectory, ".task-runner-lock"))).toBe(
      false,
    );
    run.release();
  });

  it("surfaces unexpected process lookup errors", async () => {
    // Arrange
    const root = createRoot();
    const activeDirectory = path.join(root, "logs", ".task-runner-active");
    mkdirSync(activeDirectory, { recursive: true });
    writeFileSync(path.join(activeDirectory, "unknown.json"), "12345");
    const processError = Object.assign(new Error("process lookup failed"), {
      code: "EACCES",
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw processError;
    });

    try {
      // Act & Assert
      await expect(prepareRunLogDirectory(root, "new-run")).rejects.toBe(
        processError,
      );
      expect(existsSync(path.join(root, "logs", ".task-runner-lock"))).toBe(
        false,
      );
    } finally {
      kill.mockRestore();
    }
  });
});

/**
 * Create a temporary project root for log lifecycle scenarios.
 * @returns The temporary project directory.
 * @example `createRoot()` returns an isolated log fixture root.
 */
function createRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "task-run-logs-"));
  directories.push(directory);
  return directory;
}
