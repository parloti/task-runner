import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireFileLock } from "./file-lock";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("cross-process file lock", () => {
  it("waits for the current owner and releases the lock afterward", async () => {
    // Arrange
    const lockPath = path.join(createDirectory(), "runner.lock");
    const releaseFirst = await acquireFileLock(lockPath);
    const second = acquireFileLock(lockPath);

    // Act
    releaseFirst();
    const releaseSecond = await second;
    expect(existsSync(lockPath)).toBe(true);
    releaseSecond();

    // Assert
    expect(existsSync(lockPath)).toBe(false);
  });

  it("tolerates a lock removed before release", async () => {
    // Arrange
    const lockPath = path.join(createDirectory(), "runner.lock");
    const release = await acquireFileLock(lockPath);
    rmSync(lockPath);

    // Act & Assert
    expect(() => {
      release();
    }).not.toThrow();
  });

  it("recovers a lock left by a process that exited", async () => {
    // Arrange
    const lockPath = path.join(createDirectory(), "runner.lock");
    writeFileSync(lockPath, "2147483647:stale-lock");

    // Act
    const release = await acquireFileLock(lockPath);

    // Assert
    expect(existsSync(lockPath)).toBe(true);
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("surfaces unexpected process lookup failures", async () => {
    // Arrange
    const lockPath = path.join(createDirectory(), "runner.lock");
    writeFileSync(lockPath, "12345:unknown-lock");
    const processError = Object.assign(new Error("process lookup failed"), {
      code: "EACCES",
    });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw processError;
    });

    // Act & Assert
    await expect(acquireFileLock(lockPath)).rejects.toBe(processError);
  });
});

/**
 * Create and track a temporary directory for a lock scenario.
 * @returns The temporary directory path.
 * @example `createDirectory()` gives each lock test isolated state.
 */
function createDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "task-runner-lock-"));
  directories.push(directory);
  return directory;
}
