import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  findConfiguration,
  findPackage,
  loadScripts,
  parseConfiguration,
} from "./configuration.js";

const valid = () => ({
  version: 2,
  packages: { ".": { check: { run: { kind: "shell", command: "echo hi" } } } },
});
const withTask = (task: unknown) => ({
  version: 2,
  packages: { ".": { check: task } },
});

describe("configuration boundary", () => {
  it("selects the nearest containing package, including nested directories", () => {
    // Arrange
    const config = parseConfiguration({
      version: 2,
      packages: { ".": {}, "apps/web": {} },
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
    { value: null, error: "Expected object" },
    { value: [], error: "Expected object" },
    { value: { ...valid(), version: 1 }, error: "Unsupported" },
    { value: { ...valid(), tasks: {} }, error: 'Unknown property "tasks"' },
    ...["../escape", "/absolute", "C:\\absolute", "a//b", "./a", "a#b"].map(
      (name) => ({
        value: { version: 2, packages: { [name]: {} } },
        error: "Invalid relative",
      }),
    ),
    {
      value: { version: 2, packages: { ".": { tasks: { build: {} } } } },
      error: 'Unknown property "build" in task tasks',
    },
    {
      value: { version: 2, packages: { ".": { entrypoints: { a: "b" } } } },
      error: 'Unknown property "a" in task entrypoints',
    },
    {
      value: { version: 2, packages: { ".": { " ": {} } } },
      error: "Invalid local task name",
    },
    { value: withTask({ package: "." }), error: 'Unknown property "package"' },
    { value: withTask({ dependsOn: 1 }), error: "string array" },
    { value: withTask({ dependsOn: [""] }), error: "Invalid local task name" },
    { value: withTask({ dependsOn: ["#task"] }), error: "Missing package" },
    { value: withTask({ run: { kind: "unknown" } }), error: "Command kind" },
    {
      value: withTask({
        run: { kind: "npm", script: "test", optional: "yes" },
      }),
      error: "boolean",
    },
    {
      value: withTask({ run: { kind: "npm", script: "test", args: [1] } }),
      error: "Expected string:",
    },
    {
      value: withTask({ run: { kind: "npm", script: "" } }),
      error: "non-empty",
    },
  ])("rejects malformed config: $error", ({ value, error }) => {
    // Arrange & Act & Assert
    expect(() => parseConfiguration(value)).toThrow(error);
  });

  it("parses package-local tasks, qualified dependencies, commands and options", () => {
    // Arrange
    const input = {
      version: 2,
      packages: {
        ".": {
          check: {
            dependsOn: ["apps/web#group"],
            run: {
              kind: "npm",
              script: "check",
              args: ["--fix"],
              optional: false,
            },
          },
          plain: { run: { kind: "npm", script: "check" } },
        },
        "apps/web": { group: { dependsOn: [".#plain"] } },
      },
    };
    // Act & Assert
    expect(parseConfiguration(input)).toEqual(input);
  });

  it("normalizes empty dependency lists to absent properties", () => {
    // Arrange & Act
    const parsed = parseConfiguration(withTask({ dependsOn: [] }));
    // Assert
    expect(parsed.packages["."]!["check"]).toEqual({});
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
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates manifests and package identities without rejecting script-section headers", () => {
    // Arrange
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-manifest-"));
    const manifest = path.join(directory, "package.json");
    mkdirSync(path.join(directory, "pkg"));
    const config = parseConfiguration({
      version: 2,
      packages: { ".": {}, pkg: {} },
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
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
