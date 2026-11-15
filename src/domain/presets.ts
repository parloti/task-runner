import type { RunnerConfig, RunnerDefaults, TaskDefinition } from "./types";

export interface WorkspacePresetInput {
  readonly defaults?: RunnerDefaults;
  readonly packages: RunnerConfig["packages"];
}

/**
 * Format caller-defined tasks as a version-2 runner configuration.
 * @param input Config fields to format.
 * @param input.packages Complete caller-defined package task definitions.
 * @param input.defaults Optional runner defaults.
 * @returns JSON-compatible configuration for `task-runner.json`.
 * @example `createWorkspacePreset({ packages })` returns a version-2 config.
 */
export function createWorkspacePreset(
  input: WorkspacePresetInput,
): RunnerConfig {
  const { defaults, packages } = input;
  const normalizedPackages: Record<string, Record<string, TaskDefinition>> = {};
  for (const [packagePath, tasks] of Object.entries(packages)) {
    const normalizedTasks: Record<string, TaskDefinition> = {};
    for (const [name, definition] of Object.entries(tasks)) {
      normalizedTasks[name] = {
        ...(definition.cache !== undefined && { cache: definition.cache }),
        ...(definition.dependsOn !== undefined &&
          definition.dependsOn.length > 0 && {
            dependsOn: definition.dependsOn,
          }),
        ...(definition.run !== undefined && { run: definition.run }),
      };
    }
    normalizedPackages[packagePath] = normalizedTasks;
  }
  return {
    ...(defaults !== undefined && { defaults }),
    packages: normalizedPackages,
    version: 2,
  };
}
