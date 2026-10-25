import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { taskName } from "../domain/task-name.js";
import type { CompiledTask } from "../domain/types.js";

let lastTimestamp = 0;

export function taskLogPath(directory: string, task: CompiledTask): string {
  const fullName =
    task.package === "." ? taskName(task) : `${task.package}-${taskName(task)}`;
  const name =
    stripVTControlCharacters(fullName)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 120) || "task";
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  const timestamp = new Date(lastTimestamp).toISOString().replace(/[:.]/g, "-");
  return path.join(directory, `${name}-${timestamp}.log`);
}
