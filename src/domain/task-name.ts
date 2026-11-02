import type { CompiledTask } from "./types";

const packageSuffix = (packagePath: string): string =>
  packagePath.slice(packagePath.lastIndexOf("/") + 1);

/**
 * Return a readable task name qualified by a unique package path suffix.
 * @param task Task whose package and name provide the label.
 * @param packagePaths All configured package paths.
 * @returns A task name using the package suffix, or full path when ambiguous.
 * @example `qualifiedTaskName(task, [".", "apps/web"])` returns `web:build`.
 */
export function qualifiedTaskName(
  task: CompiledTask,
  packagePaths: readonly string[],
): string {
  const { package: packagePath } = task;
  const name = taskName(task);
  if (packagePath === ".") return name;
  const suffix = packageSuffix(packagePath);
  const ambiguous = packagePaths.some(
    (candidate) =>
      candidate !== packagePath && packageSuffix(candidate) === suffix,
  );
  return `${ambiguous ? packagePath : suffix}:${name}`;
}

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
