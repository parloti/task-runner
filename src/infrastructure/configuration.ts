import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Command, RunnerConfig, TaskDefinition } from "../domain";

import { resolveTaskReference, taskReference } from "../domain";

/**
 * Locate the nearest task-runner configuration or resolve an explicit path.
 * @param cwd Directory from which upward lookup begins.
 * @param explicit Optional configuration path relative to `cwd`.
 * @returns The absolute path to the configuration file.
 * @example `findConfiguration(process.cwd())` searches upward from the current directory.
 */
export function findConfiguration(cwd: string, explicit?: string): string {
  if (explicit !== undefined) return path.resolve(cwd, explicit);
  let directory = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(directory, "task-runner.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (directory === parent)
      throw new Error(`No task-runner.json found from ${cwd}`);
    directory = parent;
  }
}

/**
 * Select the configured package that contains the current directory.
 * @param config Task-runner package configuration.
 * @param root Absolute configuration root directory.
 * @param cwd Absolute current working directory.
 * @returns The most specific matching package path.
 * @example `findPackage(config, root, process.cwd())` selects the current workspace.
 */
export function findPackage(
  config: RunnerConfig,
  root: string,
  cwd: string,
): string {
  const relative = path.relative(root, cwd).replaceAll("\\", "/");
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Working directory is outside the configuration root: ${cwd}`,
    );
  }
  const candidates = Object.keys(config.packages)
    .filter(
      (name) =>
        name === "." || relative === name || relative.startsWith(`${name}/`),
    )
    .toSorted((left, right) => right.length - left.length);
  const selected = candidates[0];
  if (selected === undefined)
    throw new Error(`Working directory has no configured package: ${cwd}`);
  return selected;
}

/**
 * Read package manifests and collect their declared npm scripts.
 * @param config Configuration whose package paths need manifests.
 * @param root Absolute directory containing the package manifests.
 * @returns Script maps keyed by configured package path.
 * @example `loadScripts(config, process.cwd())` reads scripts for every configured package.
 */
export function loadScripts(
  config: RunnerConfig,
  root: string,
): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const result = new Map<string, Record<string, string>>();
  const names = new Set<string>();
  for (const packagePath of Object.keys(config.packages)) {
    const manifestPath = path.join(root, packagePath, "package.json");
    const manifestText = readFileSync(manifestPath, "utf8");
    const manifestValue: unknown = JSON.parse(manifestText) as unknown;
    const manifest = object(manifestValue, `${packagePath}/package.json`);
    if (manifest["name"] !== undefined) {
      const name = text(manifest["name"], "package name");
      if (names.has(name)) throw new Error(`Duplicate package name: ${name}`);
      names.add(name);
    }
    const declaredScripts = object(manifest["scripts"] ?? {}, "scripts");
    const checkedScripts: [string, string][] = Object.entries(
      declaredScripts,
    ).map(([name, value]) => {
      if (typeof value !== "string")
        throw new TypeError(`Expected string: script ${name}`);
      return [name, value];
    });
    result.set(packagePath, Object.fromEntries(checkedScripts));
  }
  return result;
}

/**
 * Validate and normalize an unknown version-2 task-runner configuration.
 * @param value Parsed JSON value at the configuration boundary.
 * @returns A validated runner configuration.
 * @example `parseConfiguration(JSON.parse(source))` validates parsed JSON.
 */
export function parseConfiguration(value: unknown): RunnerConfig {
  const input = object(value, "configuration");
  if (input["version"] !== 2)
    throw new Error("Unsupported configuration version; expected 2");
  knownKeys(input, ["$comment", "packages", "version"], "configuration");
  const comment = input["$comment"];
  if (comment !== undefined && typeof comment !== "string")
    throw new TypeError("Expected string: configuration $comment");
  const packages: Record<
    string,
    Record<string, TaskDefinition>
  > = Object.fromEntries([]);
  const packageEntries = Object.entries(object(input["packages"], "packages"));
  for (const [name, item] of packageEntries) {
    if (
      name !== "." &&
      (!/^[^\\:#]+$/.test(name) ||
        name.startsWith("/") ||
        ["..", ".", ""].some((part) => name.split("/").includes(part)))
    ) {
      throw new Error(`Invalid relative package path: ${name}`);
    }
    const tasks: Record<string, TaskDefinition> = Object.fromEntries([]);
    const taskEntries = Object.entries(object(item, name));
    for (const [taskName, value] of taskEntries) {
      const id = taskReference(name, taskName);
      const task = object(value, id);
      knownKeys(task, ["dependsOn", "run"], `task ${id}`);
      const dependencies =
        task["dependsOn"] === undefined
          ? []
          : strings(task["dependsOn"], "dependencies").map((reference) => {
              resolveTaskReference(name, reference);
              return reference;
            });
      tasks[taskName] = {
        ...(dependencies.length > 0 && { dependsOn: dependencies }),
        ...(task["run"] !== undefined && { run: command(task["run"]) }),
      };
    }
    packages[name] = tasks;
  }
  return {
    ...(comment !== undefined && { $comment: comment }),
    packages,
    version: 2,
  };
}

/**
 * Validate and normalize an npm or shell command definition.
 * @param value Unknown command value from the configuration.
 * @returns A supported command definition.
 * @example `command({ kind: "shell", command: "node build.js" })` validates a shell command.
 */
function command(value: unknown): Command {
  const input = object(value, "command");
  if (input["kind"] === "shell")
    return { command: text(input["command"], "shell command"), kind: "shell" };
  if (input["kind"] !== "npm")
    throw new Error("Command kind must be npm or shell");
  if (input["optional"] !== undefined && typeof input["optional"] !== "boolean")
    throw new Error("optional must be boolean");
  return {
    kind: "npm",
    script: text(input["script"], "npm script"),
    ...(input["args"] !== undefined && {
      args: strings(input["args"], "npm args"),
    }),
    ...(input["optional"] !== undefined && { optional: input["optional"] }),
  };
}

/**
 * Reject properties that are outside a configuration object's contract.
 * @param value Object being checked.
 * @param allowed Property names accepted for this object.
 * @param label Context included in an unknown-property error.
 * @example `knownKeys(task, ["run"], "task build")` rejects undeclared fields.
 */
function knownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    throw new Error(`Unknown property "${unknown}" in ${label}`);
}

/**
 * Require a non-array object at a configuration boundary.
 * @param value Unknown value to validate.
 * @param label Context included in a validation error.
 * @returns The value narrowed to a string-keyed object.
 * @example `object(parsed, "configuration")` checks the configuration root.
 */
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Expected object: ${label}`);
  return value as Record<string, unknown>;
}

/**
 * Require an array containing only strings.
 * @param value Unknown value to validate.
 * @param label Context included in a validation error.
 * @returns A checked string array.
 * @example `strings(input["args"], "npm args")` validates command arguments.
 */
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value))
    throw new TypeError(`Expected string array: ${label}`);
  return value.map((item: unknown) => {
    if (typeof item !== "string")
      throw new TypeError(`Expected string: ${label}`);
    return item;
  });
}

/**
 * Require a non-empty string at a configuration boundary.
 * @param value Unknown value to validate.
 * @param label Context included in a validation error.
 * @returns The validated string.
 * @example `text(input["script"], "npm script")` validates a script name.
 */
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`Expected non-empty string: ${label}`);
  return value;
}
