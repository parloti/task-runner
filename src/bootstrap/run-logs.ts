import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { acquireFileLock } from "../infrastructure";

/**
 * Prepare the shared log directory and register this active invocation.
 * @param root Project root containing the logs directory.
 * @param runId Unique identifier for this invocation.
 * @returns The shared log directory and a function that unregisters this run.
 * @example `await prepareRunLogDirectory(root, runId)` clears stale logs safely.
 */
export async function prepareRunLogDirectory(
  root: string,
  runId: string,
): Promise<{ directory: string; release: () => void }> {
  const logsDirectory = path.join(root, "logs");
  const directory = path.join(logsDirectory, "task-runner");
  const activeDirectory = path.join(logsDirectory, ".task-runner-active");
  const lockPath = path.join(logsDirectory, ".task-runner-lock");
  mkdirSync(logsDirectory, { recursive: true });

  const releaseLock = await acquireFileLock(lockPath);
  const markerPath = path.join(activeDirectory, `${runId}.json`);
  try {
    mkdirSync(activeDirectory, { recursive: true });
    removeStaleMarkers(activeDirectory);
    if (readdirSync(activeDirectory).length === 0)
      rmSync(directory, { force: true, recursive: true });
    mkdirSync(directory, { recursive: true });
    const temporaryMarkerPath = `${markerPath}.tmp`;
    writeFileSync(temporaryMarkerPath, String(process.pid));
    renameSync(temporaryMarkerPath, markerPath);
  } finally {
    releaseLock();
  }

  return {
    directory,
    release: () => {
      rmSync(markerPath, { force: true });
    },
  };
}

/**
 * Check for a filesystem error with the requested code.
 * @param error Error produced by a filesystem operation.
 * @param code Expected Node.js filesystem error code.
 * @returns Whether the error has the requested code.
 * @example `hasErrorCode(error, "ENOENT")` checks a missing path.
 */
function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Check whether a filesystem error refers to a missing path.
 * @param error Error produced by a filesystem operation.
 * @returns Whether the requested path was removed or never existed.
 * @example `isMissingFile(error)` handles a lock released by another process.
 */
function isMissingFile(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

/**
 * Check whether a process identifier still belongs to a running process.
 * @param pid Process identifier read from a run marker.
 * @returns Whether the process is alive or inaccessible to this user.
 * @example `isProcessAlive(process.pid)` returns true for the current process.
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
 * Remove registration markers left by processes that are no longer running.
 * @param directory Directory containing active invocation markers.
 * @example `removeStaleMarkers(activeDirectory)` prunes crashed run records.
 */
function removeStaleMarkers(directory: string): void {
  for (const name of readdirSync(directory)) {
    const markerPath = path.join(directory, name);
    if (name.endsWith(".tmp")) {
      rmSync(markerPath, { force: true });
      continue;
    }
    let pid: number;
    try {
      pid = Number(readFileSync(markerPath, "utf8"));
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    if (!Number.isSafeInteger(pid) || pid < 1 || !isProcessAlive(pid))
      rmSync(markerPath, { force: true });
  }
}
