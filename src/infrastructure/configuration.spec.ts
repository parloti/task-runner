import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  findConfiguration,
  findPackage,
  loadScripts,
  parseConfiguration,
} from "./configuration";

const valid = () => ({
  packages: { ".": { check: { run: { command: "echo hi", kind: "shell" } } } },
  version: 2,
});
const withTask = (task: unknown) => ({
  packages: { ".": { check: task } },
  version: 2,
});

describe("configuration boundary", () => {
  it("selects the nearest containing package, including nested directories", () => {
    // Arrange
    const config = parseConfiguration({
      packages: { ".": {}, "apps/web": {} },
      version: 2,
    });
    const root = path.resolve("fixture");
    // Act & Assert
    expect(
      findPackage(config, root, path.join(root, "apps", "web", "src")),
    ).toBe("apps/web");
    expect(findPackage(config, root, path.join(root, "scripts"))).toBe(".");
    expect(() => findPackage(config, root, path.dirname(root))).toThrow(
      "outside",
    );
    expect(() => findPackage({ ...config, packages: {} }, root, root)).toThrow(
      "no configured package",
    );
    expect(() => findPackage(config, root, path.parse(root).root)).toThrow(
      "outside",
    );
    const relative = vi
      .spyOn(path, "relative")
      .mockReturnValue(path.resolve("outside"));
    try {
      expect(() => findPackage(config, root, "another-drive")).toThrow(
        "outside",
      );
    } finally {
      relative.mockRestore();
    }
  });

  it.each([
    { error: "Expected object", value: JSON.parse("null") as unknown },
    { error: "Expected object", value: [] },
    { error: "Unsupported", value: { ...valid(), version: 1 } },
    { error: 'Unknown property "tasks"', value: { ...valid(), tasks: {} } },
    ...["../escape", "/absolute", "C:\\absolute", "a//b", "./a", "a#b"].map(
      (name) => ({
        error: "Invalid relative",
        value: { packages: { [name]: {} }, version: 2 },
      }),
    ),
    {
      error: 'Unknown property "build" in task tasks',
      value: { packages: { ".": { tasks: { build: {} } } }, version: 2 },
    },
    {
      error: 'Unknown property "a" in task entrypoints',
      value: { packages: { ".": { entrypoints: { a: "b" } } }, version: 2 },
    },
    {
      error: "Invalid local task name",
      value: { packages: { ".": { " ": {} } }, version: 2 },
    },
    { error: 'Unknown property "package"', value: withTask({ package: "." }) },
    { error: "string array", value: withTask({ dependsOn: 1 }) },
    { error: "Invalid local task name", value: withTask({ dependsOn: [""] }) },
    { error: "Missing package", value: withTask({ dependsOn: ["#task"] }) },
    { error: "Command kind", value: withTask({ run: { kind: "unknown" } }) },
    {
      error: "boolean",
      value: withTask({
        run: { kind: "npm", optional: "yes", script: "test" },
      }),
    },
    {
      error: "Expected string:",
      value: withTask({ run: { args: [1], kind: "npm", script: "test" } }),
    },
    {
      error: "non-empty",
      value: withTask({ run: { kind: "npm", script: "" } }),
    },
  ])("rejects malformed config: $error", ({ error, value }) => {
    // Arrange & Act & Assert
    expect(() => parseConfiguration(value)).toThrow(error);
  });

  it("parses package-local tasks, qualified dependencies, commands and options", () => {
    // Arrange
    const input = {
      packages: {
        ".": {
          check: {
            dependsOn: ["apps/web#group"],
            run: {
              args: ["--fix"],
              kind: "npm",
              optional: false,
              script: "check",
            },
          },
          plain: { run: { kind: "npm", script: "check" } },
        },
        "apps/web": { group: { dependsOn: [".#plain"] } },
      },
      version: 2,
    };
    // Act & Assert
    expect(parseConfiguration(input)).toEqual(input);
  });

  it("normalizes empty dependency lists to absent properties", () => {
    // Arrange & Act
    const parsed = parseConfiguration(withTask({ dependsOn: [] }));
    // Assert
    expect(parsed.packages["."]?.["check"]).toEqual({});
  });

  it("discovers parent configuration or honors explicit paths, and fails clearly when absent", () => {
    // Arrange
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-config-"));
    const nested = path.join(directory, "apps", "web");
    mkdirSync(nested, { recursive: true });
    const configPath = path.join(directory, "task-runner.json");
    writeFileSync(configPath, "{}");
    try {
      // Act & Assert
      expect(findConfiguration(nested)).toBe(configPath);
      expect(findConfiguration(directory, "other.json")).toBe(
        path.join(directory, "other.json"),
      );
      expect(() => findConfiguration(path.parse(directory).root)).toThrow(
        "No task-runner.json",
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("validates manifests and package identities without rejecting script-section headers", () => {
    // Arrange
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-manifest-"));
    const manifest = path.join(directory, "package.json");
    mkdirSync(path.join(directory, "pkg"));
    const config = parseConfiguration({
      packages: { ".": {}, pkg: {} },
      version: 2,
    });
    try {
      // Act & Assert
      writeFileSync(manifest, '{"name":"root","scripts":{"header":""}}');
      writeFileSync(path.join(directory, "pkg", "package.json"), "{}");
      expect(loadScripts(config, directory).get(".")).toEqual({ header: "" });
      writeFileSync(
        path.join(directory, "pkg", "package.json"),
        '{"name":"root"}',
      );
      expect(() => loadScripts(config, directory)).toThrow("Duplicate package");
      writeFileSync(manifest, '{"scripts":{"bad":7}}');
      expect(() => loadScripts(config, directory)).toThrow("Expected string");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
