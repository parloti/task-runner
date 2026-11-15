import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface CacheRecord {
  readonly completedAt: string;
  readonly fingerprint: string;
  readonly outputs: string;
  readonly version: 1;
}

/**
 * Read and validate a prior success without treating IO failures as misses.
 * @param file Cache record path.
 * @returns A validated record, or absence when it has not been recorded.
 * @example `readCacheRecord(file)` rejects malformed cache data.
 */
export async function readCacheRecord(
  file: string,
): Promise<CacheRecord | undefined> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  const message = `Invalid task cache record: ${file}; rerun with --no-cache`;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
  if (
    value === null ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("fingerprint" in value) ||
    typeof value.fingerprint !== "string" ||
    !("outputs" in value) ||
    typeof value.outputs !== "string" ||
    !("completedAt" in value) ||
    typeof value.completedAt !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.fingerprint) ||
    !/^[a-f0-9]{64}$/u.test(value.outputs) ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    new Date(value.completedAt).toISOString() !== value.completedAt
  )
    throw new Error(message);
  return {
    completedAt: value.completedAt,
    fingerprint: value.fingerprint,
    outputs: value.outputs,
    version: 1,
  };
}

/**
 * Atomically replace one successful-result record and clean up failed writes.
 * @param file Cache record path.
 * @param record Successful fingerprint and artifact snapshot.
 * @returns Completion of the record replacement.
 * @example `writeCacheRecord(file, record)` never publishes partial JSON.
 */
export async function writeCacheRecord(
  file: string,
  record: CacheRecord,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Task cache write and cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}
