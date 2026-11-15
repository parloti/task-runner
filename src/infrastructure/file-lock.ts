import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const lockRetryMs = 20;

/**
 * Acquire a cross-process lock, recovering a lock left by an exited process.
 * @param lockPath Filesystem path used to serialize a critical section.
 * @returns A function that releases the acquired lock.
 * @example `await acquireFileLock(lockPath)` protects an atomic file update.
 */
export async function acquireFileLock(lockPath: string): Promise<() => void> {
  const owner = `${String(process.pid)}:${randomUUID()}`;
  const releaseLock = (): void => {
    try {
      if (readFileSync(lockPath, "utf8") === owner) unlinkSync(lockPath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  };
  for (;;) {
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, "wx");
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      removeStaleLock(lockPath);
      await new Promise((resolve) => setTimeout(resolve, lockRetryMs));
      continue;
    }
    try {
      writeFileSync(descriptor, owner);
      closeSync(descriptor);
    } catch (error) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the owner-marker write or close error.
      }
      try {
        unlinkSync(lockPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Lock creation and cleanup failed",
          { cause: cleanupError },
        );
      }
      throw error;
    }
    return releaseLock;
  }
}

/**
 * Check whether a filesystem error has a requested code.
 * @param error Filesystem error produced by Node.js.
 * @param code Expected Node.js filesystem error code.
 * @returns Whether the error has the requested code.
 * @example `hasErrorCode(error, "EEXIST")` recognizes lock contention.
 */
function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Check whether a lock creation failed because another writer owns it.
 * @param error Filesystem error produced by exclusive lock creation.
 * @returns Whether the lock already exists.
 * @example `isAlreadyExists(error)` recognizes `open(..., "wx")` contention.
 */
function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}

/**
 * Check whether a filesystem path is absent.
 * @param error Filesystem error produced while reading a path.
 * @returns Whether the requested path does not exist.
 * @example `isMissingFile(error)` handles a lock released by another process.
 */
function isMissingFile(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

/**
 * Check whether a process remains alive or is inaccessible to this user.
 * @param pid Process identifier from a lock owner marker.
 * @returns Whether the process may still own the lock.
 * @example `isProcessAlive(process.pid)` returns true for this process.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "EPERM")) return true;
    if (hasErrorCode(error, "ESRCH")) return false;
    throw error;
  }
}

/**
 * Remove a lock whose owning process has exited.
 * @param lockPath Filesystem path to the lock file.
 * @example `removeStaleLock(lockPath)` recovers after an interrupted writer.
 */
function removeStaleLock(lockPath: string): void {
  if (!existsSync(lockPath)) return;
  let owner: string;
  try {
    owner = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  const [pidText] = owner.split(":", 1);
  const pid = Number(pidText);
  if (Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) return;
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (owner.length === 0 && age < 1000) return;
    if (readFileSync(lockPath, "utf8") === owner) unlinkSync(lockPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}
