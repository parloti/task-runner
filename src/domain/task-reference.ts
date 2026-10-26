import { make } from "ts-brand";

import type { TaskId } from "./types";

const taskId = make<TaskId>();

/**
 * Resolve a local or qualified reference to a canonical task ID.
 * @param packagePath Package containing a local reference.
 * @param reference Task name or `&lt;package>#&lt;task>` reference.
 * @returns The canonical branded task ID.
 * @example `resolveTaskReference("apps/web", ".#build")` selects the root task.
 */
export function resolveTaskReference(
  packagePath: string,
  reference: string,
): TaskId {
  const separator = reference.indexOf("#");
  if (separator === -1) return taskReference(packagePath, reference);
  const scope = reference.slice(0, separator);
  if (!scope)
    throw new Error(`Missing package in task reference: ${reference}`);
  return taskReference(scope, reference.slice(separator + 1));
}

/**
 * Create the canonical ID for a task in a package.
 * @param packagePath Package path, or `.` for the root package.
 * @param name Local task name.
 * @returns The branded task ID used by the compiled graph.
 * @example `taskReference("apps/web", "build")` returns `apps/web#build`.
 */
export function taskReference(packagePath: string, name: string): TaskId {
  if (!name.trim() || name.includes("#"))
    throw new Error(`Invalid local task name: ${name}`);
  if (packagePath.includes("#"))
    throw new Error(`Invalid package path: ${packagePath}`);
  return taskId(packagePath === "." ? name : `${packagePath}#${name}`);
}
