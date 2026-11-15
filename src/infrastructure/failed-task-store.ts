import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { acquireFileLock } from "./file-lock";

interface FailedTaskRecord {
  readonly completedAt: number;
  readonly failedTasks: readonly string[];
  readonly runId: string;
  readonly version: 2;
}

interface FailedTaskStore {
  read: () => Promise<readonly string[]>;
  write: (
    failedTasks: readonly string[],
    completedAt?: number,
    runId?: string,
  ) => Promise<void>;
}

interface ReadFailedTaskRecord {
  readonly completedAt: number;
  readonly failedTasks: readonly string[];
  readonly runId: string;
}

/**
 * Read or replace failed-command candidates for one configuration file.
 * @param root Absolute configuration root.
 * @param configPath Absolute path to the selected configuration file.
 * @returns A local store independent of short-lived invocation logs.
 * @example `createFailedTaskStore(root).read()` loads the previous run failures.
 */
export function createFailedTaskStore(
  root: string,
  configPath = path.join(root, "task-runner.json"),
): FailedTaskStore {
  const resolvedConfigPath = path.resolve(configPath);
  const normalizedConfigPath =
    process.platform === "win32"
      ? resolvedConfigPath.toLowerCase()
      : resolvedConfigPath;
  const configBasename = path.basename(resolvedConfigPath);
  const configurationId = createHash("sha256")
    .update(normalizedConfigPath)
    .digest("hex");
  const isDefaultConfig =
    configBasename === "task-runner.json" ||
    (process.platform === "win32" &&
      configBasename.toLowerCase() === "task-runner.json");
  const configurationSuffix = isDefaultConfig ? "" : `-${configurationId}`;
  const file = path.join(
    root,
    ".cache",
    "task-runner",
    `last-failed-tasks${configurationSuffix}.json`,
  );
  const lockPath = `${file}.lock`;
  const readRecord = async (): Promise<ReadFailedTaskRecord | undefined> => {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    const message = `Invalid failed-task record: ${file}`;
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new Error(message, { cause: error });
    }
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("version" in value) ||
      !("failedTasks" in value) ||
      !Array.isArray(value.failedTasks)
    )
      throw new Error(message);

    const storedTasks: readonly unknown[] = value.failedTasks;
    const failedTasks: string[] = [];
    for (const task of storedTasks) {
      if (typeof task !== "string" || task.length === 0)
        throw new Error(message);
      failedTasks.push(task);
    }
    if (value.version === 1) return { completedAt: 0, failedTasks, runId: "" };
    if (
      value.version !== 2 ||
      !("completedAt" in value) ||
      typeof value.completedAt !== "number" ||
      !Number.isFinite(value.completedAt) ||
      value.completedAt < 0 ||
      !("runId" in value) ||
      typeof value.runId !== "string" ||
      value.runId.length === 0
    )
      throw new Error(message);
    return { completedAt: value.completedAt, failedTasks, runId: value.runId };
  };
  return {
    async read(): Promise<readonly string[]> {
      const record = await readRecord();
      return record?.failedTasks ?? [];
    },
    async write(
      failedTasks,
      completedAt = performance.timeOrigin + performance.now(),
      runId = randomUUID(),
    ): Promise<void> {
      if (!Number.isFinite(completedAt) || completedAt < 0)
        throw new Error("Failed-task completion time must be non-negative");
      if (runId.length === 0) throw new Error("Failed-task run ID is empty");
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      const record: FailedTaskRecord = {
        completedAt,
        failedTasks: [...new Set(failedTasks)],
        runId,
        version: 2,
      };
      const releaseLock = await acquireFileLock(lockPath);
      try {
        const current = await readRecord();
        if (current === undefined || !isNewer(current, record)) {
          await writeFile(temporary, `${JSON.stringify(record)}\n`, {
            flag: "wx",
          });
          await rename(temporary, file);
        }
      } catch (error) {
        let failure: unknown = error;
        try {
          await rm(temporary, { force: true });
        } catch (cleanupError) {
          failure = new AggregateError(
            [error, cleanupError],
            "Failed-task record write and cleanup failed",
            { cause: cleanupError },
          );
        }
        try {
          releaseLock();
        } catch (lockError) {
          throw new AggregateError(
            [failure, lockError],
            "Failed-task record update and lock release failed",
            { cause: lockError },
          );
        }
        throw failure;
      }
      try {
        releaseLock();
      } catch (error) {
        throw new Error("Failed to release failed-task record lock", {
          cause: error,
        });
      }
    },
  };
}

/**
 * Check whether a filesystem path is absent.
 * @param error Filesystem error produced while reading a path.
 * @returns Whether the requested path does not exist.
 * @example `isMissingFile(error)` handles a not-yet-created state record.
 */
function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Compare two run records by completion time, then by unique run ID.
 * @param left Existing persisted run.
 * @param right Candidate update.
 * @returns Whether the existing run completed later than the candidate.
 * @example `isNewer(existing, candidate)` prevents a late stale write.
 */
function isNewer(
  left: Pick<ReadFailedTaskRecord, "completedAt" | "runId">,
  right: Pick<FailedTaskRecord, "completedAt" | "runId">,
): boolean {
  return (
    left.completedAt > right.completedAt ||
    (left.completedAt === right.completedAt && left.runId > right.runId)
  );
}
