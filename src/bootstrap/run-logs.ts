import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const lockRetryMs = 20;

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

  const releaseLock = await acquireLock(lockPath);
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
 * Serialize directory cleanup and active-run registration across processes.
 * @param lockPath Filesystem path used as the registration lock.
 * @returns A function that releases the acquired lock.
 * @example `await acquireLock(lockPath)` protects log startup changes.
 */
async function acquireLock(lockPath: string): Promise<() => void> {
  const owner = `${String(process.pid)}:${randomUUID()}`;
  for (;;) {
    try {
      const descriptor = openSync(lockPath, "wx");
      try {
        writeFileSync(descriptor, owner);
      } finally {
        closeSync(descriptor);
      }
      return () => {
        unlinkSync(lockPath);
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      removeStaleLock(lockPath);
      await new Promise((resolve) => setTimeout(resolve, lockRetryMs));
    }
  }
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
 * Check whether an error means a lock already exists.
 * @param error Error produced by exclusive lock creation.
 * @returns Whether another process currently owns the lock path.
 * @example `isAlreadyExists(error)` recognizes `open(..., "wx")` contention.
 */
function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
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
 * Clear a lock file whose owner process has exited.
 * @param lockPath Filesystem path to the lock file.
 * @example `removeStaleLock(lockPath)` unblocks after a crashed owner.
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
    // Ignore a lock that another process replaced while this owner was checked.
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (owner.length === 0 && age < 1000) return;
    if (readFileSync(lockPath, "utf8") === owner) unlinkSync(lockPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
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
