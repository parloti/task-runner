import type { CompiledTask } from "./types";

/**
 * Return the readable display name for a compiled task.
 * @param task Task whose command or configured ID provides the name.
 * @returns The task label without its package prefix.
 * @example `taskName(task)` returns an npm script name when the task runs npm.
 */
export function taskName(task: CompiledTask): string {
  if (task.run?.kind === "npm") return task.run.script;
  const prefix = `${task.package}#`;
  const name = task.id.startsWith(prefix)
    ? task.id.slice(prefix.length)
    : task.id;
  return name.startsWith("validation:")
    ? name.slice("validation:".length)
    : name;
}
