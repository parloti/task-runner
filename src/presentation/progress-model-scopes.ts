import type { CompiledTask } from "../domain";

/**
 * Identify validation groups that establish a workspace display scope.
 * @param task Candidate commandless validation group.
 * @param dependencies Its direct compiled prerequisites.
 * @returns The workspace path when the group owns one, otherwise `undefined`.
 * @example `validationScope(group, dependencies)` returns the matching workspace path.
 */
export function validationScope(
  task: CompiledTask,
  dependencies: readonly CompiledTask[],
): string | undefined {
  const packagePath = dependencies[0]?.package;
  const workspaceName = packagePath?.split("/").at(-1);
  return packagePath !== undefined &&
    workspaceName !== undefined &&
    task.run === undefined &&
    task.id === `validate:${workspaceName}` &&
    dependencies.every((dependency) => dependency.package === packagePath)
    ? packagePath
    : undefined;
}
