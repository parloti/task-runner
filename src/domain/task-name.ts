import type { CompiledTask } from "./types.js";

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
