import { make } from "ts-brand";
import type { TaskId } from "./types.js";

const taskId = make<TaskId>();

export function taskReference(packagePath: string, name: string): TaskId {
  if (!name.trim() || name.includes("#"))
    throw new Error(`Invalid local task name: ${name}`);
  if (packagePath.includes("#"))
    throw new Error(`Invalid package path: ${packagePath}`);
  return taskId(packagePath === "." ? name : `${packagePath}#${name}`);
}

export function resolveTaskReference(
  packagePath: string,
  reference: string,
): TaskId {
  const separator = reference.indexOf("#");
  if (separator < 0) return taskReference(packagePath, reference);
  const scope = reference.slice(0, separator);
  if (!scope)
    throw new Error(`Missing package in task reference: ${reference}`);
  return taskReference(scope, reference.slice(separator + 1));
}
