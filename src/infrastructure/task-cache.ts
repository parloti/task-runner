import { createHash } from "node:crypto";
import path from "node:path";

import type { CacheLookup, ExecutionCache } from "../application";
import type { CompiledTask, TaskId } from "../domain";

import { readCacheRecord, writeCacheRecord } from "./cache-record";
import { type FileSnapshot, snapshotFiles } from "./cache-snapshot";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Persist successful task checkpoints independently of short-lived run logs.
 * @param root Absolute configuration root.
 * @param noCache Whether to bypass reads while still refreshing successful entries.
 * @returns A content-based, atomic local cache adapter.
 * @example `createTaskCache(root, true)` forces execution and refreshes records.
 */
export function createTaskCache(root: string, noCache = false): ExecutionCache {
  const directory = path.join(root, ".cache", "task-runner");
  const initial = new Map<TaskId, string>();
  const snapshots = new Map<string, Promise<FileSnapshot>>();
  const finalSnapshots = new Map<string, Promise<FileSnapshot>>();
  const inputSnapshot = (
    task: CompiledTask,
    memo: Map<string, Promise<FileSnapshot>>,
  ): Promise<FileSnapshot> => {
    if (task.cache === undefined)
      throw new Error(`Task has no cache definition: ${task.id}`);
    const key = JSON.stringify([task.cache.inputs, task.cache.exclude]);
    let pending = memo.get(key);
    if (pending === undefined) {
      pending = snapshotFiles(root, task.cache.inputs, task.cache.exclude);
      memo.set(key, pending);
    }
    return pending;
  };
  const fingerprint = (
    task: CompiledTask,
    members: readonly CompiledTask[],
    snapshot: FileSnapshot,
  ): string =>
    digest({
      arch: process.arch,
      env: (task.cache?.env ?? []).map((name) => [name, process.env[name]]),
      inputs: snapshot.digest,
      members: members.toSorted((left, right) =>
        left.id.localeCompare(right.id),
      ),
      node: process.version,
      platform: process.platform,
      version: 1,
    });
  const recordPath = (task: CompiledTask): string =>
    path.join(directory, `${digest(task.id)}.json`);
  return {
    async lookup(task, members): Promise<CacheLookup> {
      const inputs = await inputSnapshot(task, snapshots);
      const current = fingerprint(task, members, inputs);
      initial.set(task.id, current);
      if (noCache) return { hit: false, reason: "bypassed" };
      if (inputs.empty) return { hit: false, reason: "no-input-files" };
      const file = recordPath(task);
      const record = await readCacheRecord(file);
      if (record === undefined) return { hit: false, reason: "not-recorded" };
      if (record.fingerprint !== current)
        return { hit: false, reason: "inputs-changed" };
      const outputs = await snapshotFiles(root, task.cache?.outputs ?? []);
      if (!outputs.complete) return { hit: false, reason: "outputs-missing" };
      if (record.outputs !== outputs.digest)
        return { hit: false, reason: "outputs-changed" };
      return { completedAt: record.completedAt, hit: true };
    },
    async store(task, members, completedAt): Promise<string | undefined> {
      const inputs = await inputSnapshot(task, finalSnapshots);
      if (inputs.empty) return "no-input-files";
      if (initial.get(task.id) !== fingerprint(task, members, inputs))
        return "inputs-changed-during-run";
      const outputs = await snapshotFiles(root, task.cache?.outputs ?? []);
      if (!outputs.complete) return "outputs-missing";
      await writeCacheRecord(recordPath(task), {
        completedAt,
        fingerprint: fingerprint(task, members, inputs),
        outputs: outputs.digest,
        version: 1,
      });
      return undefined;
    },
  };
}
