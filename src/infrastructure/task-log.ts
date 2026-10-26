import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { CompiledTask } from "../domain";

import { taskName } from "../domain";

const lastTimestamp = { value: 0 };

/**
 * Build a unique, filesystem-safe log path for a command task.
 * @param directory Directory that stores task logs.
 * @param task Task whose readable identity forms the filename.
 * @returns A unique absolute log path.
 * @example `taskLogPath(logDirectory, task)` creates a timestamped task log path.
 */
export function taskLogPath(directory: string, task: CompiledTask): string {
  const fullName =
    task.package === "." ? taskName(task) : `${task.package}-${taskName(task)}`;
  const name =
    stripVTControlCharacters(fullName)
      .replaceAll(/[^a-zA-Z0-9._-]+/g, "-")
      .replaceAll(/^[.-]+|[.-]+$/g, "")
      .slice(0, 120) || "task";
  lastTimestamp.value = Math.max(Date.now(), lastTimestamp.value + 1);
  const timestamp = new Date(lastTimestamp.value)
    .toISOString()
    .replaceAll(/[:.]/g, "-");
  return path.join(directory, `${name}-${timestamp}.log`);
}
