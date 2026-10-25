import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import type { Command, RunnerConfig, TaskDefinition } from "../domain/types.js";
import {
  taskReference,
  resolveTaskReference,
} from "../domain/task-reference.js";

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Expected object: ${label}`);
  return value as Record<string, unknown>;
}

function knownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined)
    throw new Error(`Unknown property "${unknown}" in ${label}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`Expected non-empty string: ${label}`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Expected string array: ${label}`);
  return value.map((item: unknown) => {
    if (typeof item !== "string") throw new Error(`Expected string: ${label}`);
    return item;
  });
}

function command(value: unknown): Command {
  const input = object(value, "command");
  if (input["kind"] === "shell")
    return { kind: "shell", command: text(input["command"], "shell command") };
  if (input["kind"] !== "npm")
    throw new Error("Command kind must be npm or shell");
  if (input["optional"] !== undefined && typeof input["optional"] !== "boolean")
    throw new Error("optional must be boolean");
  return {
    kind: "npm",
    script: text(input["script"], "npm script"),
    ...(input["args"] === undefined
      ? {}
      : { args: strings(input["args"], "npm args") }),
    ...(input["optional"] === undefined ? {} : { optional: input["optional"] }),
  };
}

export function parseConfiguration(value: unknown): RunnerConfig {
  const input = object(value, "configuration");
  if (input["version"] !== 2)
    throw new Error("Unsupported configuration version; expected 2");
  knownKeys(input, ["packages", "version"], "configuration");
  const packages: Record<
    string,
    Record<string, TaskDefinition>
  > = Object.fromEntries([]);
  for (const [name, item] of Object.entries(
    object(input["packages"], "packages"),
  )) {
    if (
      name !== "." &&
      (!/^[^\\:#]+$/.test(name) ||
        name.startsWith("/") ||
        name
          .split("/")
          .some((part) => part === ".." || part === "." || part === ""))
    ) {
      throw new Error(`Invalid relative package path: ${name}`);
    }
    const tasks: Record<string, TaskDefinition> = Object.fromEntries([]);
    for (const [taskName, value] of Object.entries(object(item, name))) {
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
        ...(dependencies.length === 0 ? {} : { dependsOn: dependencies }),
        ...(task["run"] === undefined ? {} : { run: command(task["run"]) }),
      };
    }
    packages[name] = tasks;
  }
  return { version: 2, packages };
}

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
    .sort((left, right) => right.length - left.length);
  const selected = candidates[0];
  if (selected === undefined)
    throw new Error(`Working directory has no configured package: ${cwd}`);
  return selected;
}

export function loadScripts(
  config: RunnerConfig,
  root: string,
): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const result = new Map<string, Record<string, string>>();
  const names = new Set<string>();
  for (const packagePath of Object.keys(config.packages)) {
    const manifest = object(
      JSON.parse(
        readFileSync(path.join(root, packagePath, "package.json"), "utf8"),
      ),
      `${packagePath}/package.json`,
    );
    if (manifest["name"] !== undefined) {
      const name = text(manifest["name"], "package name");
      if (names.has(name)) throw new Error(`Duplicate package name: ${name}`);
      names.add(name);
    }
    result.set(
      packagePath,
      Object.fromEntries(
        Object.entries(object(manifest["scripts"] ?? {}, "scripts")).map(
          ([name, value]) => {
            if (typeof value !== "string")
              throw new Error(`Expected string: script ${name}`);
            return [name, value];
          },
        ),
      ),
    );
  }
  return result;
}
