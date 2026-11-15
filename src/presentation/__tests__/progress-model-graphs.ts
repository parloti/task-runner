import { make } from "ts-brand";

import type { CompiledTask, TaskId } from "../../domain";

const id = make<TaskId>();
const task = (
  name: string,
  dependencies: string[] = [],
  command = true,
  packagePath = ".",
): CompiledTask => ({
  dependsOn: dependencies.map((dependency) => id(dependency)),
  id: id(name),
  package: packagePath,
  ...(command && {
    run: {
      kind: "npm",
      script: name.startsWith(`${packagePath}#`)
        ? name.slice(packagePath.length + 1)
        : name,
    } as const,
  }),
});

/**
 * Create the configured graph used by shared workspace build display tests.
 * @returns Task definitions for a project with several dependent packages.
 * @example `sharedBuildTasks()` returns workspace build task definitions.
 */
export function sharedBuildTasks(): CompiledTask[] {
  return [
    task(
      "validate",
      [
        "lint",
        "build",
        "validate:automation",
        "validate:back",
        "validate:contract",
      ],
      false,
    ),
    task(
      "build",
      ["apps/automation#build", "apps/back#build", "packages/contract#build"],
      false,
    ),
    task("lint", ["prettier", "eslint"], false),
    task("prettier"),
    task("eslint"),
    task("validate:automation", ["apps/automation#build"], false),
    task("validate:back", ["apps/back#build"], false),
    task("validate:contract", ["packages/contract#build"], false),
    task(
      "apps/automation#build",
      [
        "packages/contract#build",
        "apps/automation#clean",
        "apps/automation#compile",
        "apps/automation#resolve-paths",
      ],
      false,
      "apps/automation",
    ),
    task(
      "apps/back#build",
      [
        "packages/contract#build",
        "apps/back#clean",
        "apps/back#compile",
        "apps/back#resolve-paths",
      ],
      false,
      "apps/back",
    ),
    task(
      "packages/contract#build",
      [
        "packages/contract#clean",
        "packages/contract#compile",
        "packages/contract#resolve-paths",
      ],
      false,
      "packages/contract",
    ),
    task(
      "apps/automation#clean",
      ["packages/contract#build"],
      true,
      "apps/automation",
    ),
    task(
      "apps/automation#compile",
      ["apps/automation#clean"],
      true,
      "apps/automation",
    ),
    task(
      "apps/automation#resolve-paths",
      ["apps/automation#compile"],
      true,
      "apps/automation",
    ),
    task("apps/back#clean", ["packages/contract#build"], true, "apps/back"),
    task("apps/back#compile", ["apps/back#clean"], true, "apps/back"),
    task("apps/back#resolve-paths", ["apps/back#compile"], true, "apps/back"),
    task("packages/contract#clean", [], true, "packages/contract"),
    task(
      "packages/contract#compile",
      ["packages/contract#clean"],
      true,
      "packages/contract",
    ),
    task(
      "packages/contract#resolve-paths",
      ["packages/contract#compile"],
      true,
      "packages/contract",
    ),
  ];
}

/**
 * Create the configured graph used by workspace phase timing tests.
 * @returns Task definitions for three validating workspaces.
 * @example `workspacePhaseTasks()` returns ordered workspace phases.
 */
export function workspacePhaseTasks(): CompiledTask[] {
  return [
    task("validate", ["validate:lib", "validate:web", "validate:back"], false),
    task(
      "validate:lib",
      ["packages/lib#build", "packages/lib#pack", "packages/lib#test:all"],
      false,
    ),
    task(
      "validate:web",
      ["apps/web#build", "apps/web#pack", "apps/web#test:all"],
      false,
    ),
    task(
      "validate:back",
      ["apps/back#build", "apps/back#pack", "apps/back#test:all"],
      false,
    ),
    task(
      "packages/lib#build",
      [
        "packages/lib#clean",
        "packages/lib#compile",
        "packages/lib#resolve-paths",
      ],
      false,
      "packages/lib",
    ),
    task(
      "apps/web#build",
      [
        "packages/lib#build",
        "apps/web#clean",
        "apps/web#compile",
        "apps/web#resolve-paths",
      ],
      false,
      "apps/web",
    ),
    task(
      "apps/back#build",
      [
        "packages/lib#build",
        "apps/back#clean",
        "apps/back#compile",
        "apps/back#resolve-paths",
      ],
      false,
      "apps/back",
    ),
    task("packages/lib#clean", [], true, "packages/lib"),
    task("packages/lib#compile", ["packages/lib#clean"], true, "packages/lib"),
    task(
      "packages/lib#resolve-paths",
      ["packages/lib#compile"],
      true,
      "packages/lib",
    ),
    task("packages/lib#pack", ["packages/lib#build"], true, "packages/lib"),
    task("packages/lib#test:all", ["packages/lib#test"], false, "packages/lib"),
    task("packages/lib#test", [], true, "packages/lib"),
    task("apps/web#clean", ["packages/lib#build"], true, "apps/web"),
    task("apps/web#compile", ["apps/web#clean"], true, "apps/web"),
    task("apps/web#resolve-paths", ["apps/web#compile"], true, "apps/web"),
    task("apps/web#pack", ["apps/web#build"], true, "apps/web"),
    task("apps/web#test:all", ["apps/web#test"], false, "apps/web"),
    task("apps/web#test", [], true, "apps/web"),
    task("apps/back#clean", ["packages/lib#build"], true, "apps/back"),
    task("apps/back#compile", ["apps/back#clean"], true, "apps/back"),
    task("apps/back#resolve-paths", ["apps/back#compile"], true, "apps/back"),
    task("apps/back#pack", ["apps/back#build"], true, "apps/back"),
    task("apps/back#test:all", ["apps/back#test"], false, "apps/back"),
    task("apps/back#test", [], true, "apps/back"),
  ];
}
