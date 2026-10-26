import { make } from "ts-brand";

import type {
  CompiledTask,
  RunnerConfig,
  TaskDefinition,
  TaskId,
} from "./types";

import { resolveTaskReference, taskReference } from "./task-reference";

const taskId = make<TaskId>();

/**
 * Validate task definitions and compile the prerequisites of one target.
 * @param config Version-2 configuration containing package task definitions.
 * @param target Local or qualified entrypoint reference.
 * @param scripts Package scripts used to validate declared npm commands.
 * @returns Reachable tasks keyed by canonical task ID.
 * @example `compileGraph(config, "build", scripts)` prepares the `build` graph.
 */
export function compileGraph(
  config: RunnerConfig,
  target: string,
  scripts: ReadonlyMap<string, Readonly<Record<string, string>>>,
): ReadonlyMap<TaskId, CompiledTask> {
  const graph = new Map<TaskId, CompiledTask>();
  const definitions = new Map<
    TaskId,
    { package: string; task: TaskDefinition }
  >();
  for (const [packagePath, tasks] of Object.entries(config.packages)) {
    for (const [name, task] of Object.entries(tasks)) {
      definitions.set(taskReference(packagePath, name), {
        package: packagePath,
        task,
      });
    }
  }
  const visiting: string[] = [];
  const visit = (name: string): void => {
    if (visiting.includes(name)) {
      throw new Error(
        `Circular task dependency: ${[...visiting, name].join(" -> ")}`,
      );
    }
    if (graph.has(taskId(name))) return;
    const definition = definitions.get(taskId(name));
    if (definition === undefined) throw new Error(`Unknown task: ${name}`);
    const packageScripts = scripts.get(definition.package);
    if (packageScripts === undefined)
      throw new Error(`Unknown package: ${definition.package}`);
    visiting.push(name);
    const dependencies = (definition.task.dependsOn ?? []).map((reference) =>
      resolveTaskReference(definition.package, reference),
    );
    for (const dependency of dependencies) visit(dependency);
    visiting.pop();
    const run = definition.task.run;
    const missing =
      run?.kind === "npm" &&
      (!Object.hasOwn(packageScripts, run.script) ||
        !packageScripts[run.script]?.trim());
    if (missing && !run.optional) {
      throw new Error(
        `Missing required npm script "${run.script}" in ${definition.package}`,
      );
    }
    if (
      run?.kind === "npm" &&
      /^task-runner(?:\s|$)/.test(packageScripts[run.script] ?? "")
    ) {
      throw new Error(
        `Recursive runner wrapper: ${definition.package}:${run.script}; use an explicit task dependency`,
      );
    }
    graph.set(taskId(name), {
      dependsOn: dependencies,
      id: taskId(name),
      package: definition.package,
      ...(run !== undefined && { run }),
      skip: missing,
    });
  };
  // Validate every definition, including targets outside the selected entrypoint.
  for (const name of definitions.keys()) visit(name);
  const targetId = resolveTaskReference(".", target);
  if (!graph.has(targetId)) throw new Error(`Unknown task: ${target}`);
  const selected = new Map<TaskId, CompiledTask>();
  const select = (name: TaskId): void => {
    if (selected.has(name)) return;
    const task = graph.get(name);
    if (task === undefined)
      throw new Error(`Compiled task is missing from graph: ${name}`);
    for (const dependency of task.dependsOn) select(dependency);
    selected.set(name, task);
  };
  select(targetId);
  return selected;
}
