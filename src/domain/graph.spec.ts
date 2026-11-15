import { describe, expect, it } from "vitest";

import type { RunnerConfig, TaskDefinition } from "./types";

import { compileGraph } from "./graph";
import { resolveTaskReference, taskReference } from "./task-reference";

const tasks: Record<string, TaskDefinition> = {
  end: { dependsOn: ["left", "right"] },
  left: { dependsOn: ["start"] },
  right: { dependsOn: ["start"] },
  start: { run: { kind: "npm", script: "check" } },
  unrelated: {},
};
const config: RunnerConfig = { packages: { ".": tasks }, version: 2 };

describe("graph compilation", () => {
  it("selects a diamond graph once without unrelated work", () => {
    // Arrange & Act
    const graph = compileGraph(config, "end");
    // Assert
    expect(graph.keys().toArray()).toEqual(["start", "left", "right", "end"]);
  });

  it("starts a command without selecting command or group prerequisites", () => {
    // Arrange
    const workflow: RunnerConfig = {
      packages: {
        ".": {
          mutation: {
            dependsOn: ["test", "setup"],
            run: { kind: "npm", script: "mutation" },
          },
          prepare: { run: { kind: "npm", script: "prepare" } },
          setup: { dependsOn: ["prepare"] },
          test: { run: { kind: "npm", script: "test" } },
        },
      },
      version: 2,
    };
    // Act
    const graph = compileGraph(workflow, "mutation");

    // Assert
    expect(graph.keys().toArray()).toEqual(["mutation"]);
    expect(graph.get(taskReference(".", "mutation"))?.dependsOn).toEqual([]);
  });

  it.each([
    { members: ["lib#mutation", "app#mutation"], target: "mutation" },
    { members: ["app#mutation"], target: "mutation:app" },
    { members: ["app#mutation"], target: "app#mutation" },
  ])(
    "starts $target without earlier tests or builds",
    ({ members, target }) => {
      // Arrange
      const workflow: RunnerConfig = {
        packages: {
          ".": {
            mutation: { dependsOn: ["mutation:lib", "mutation:app"] },
            "mutation:app": { dependsOn: ["app#mutation"] },
            "mutation:lib": { dependsOn: ["lib#mutation"] },
          },
          app: {
            build: { dependsOn: ["compile"] },
            compile: { run: { command: "compile", kind: "shell" } },
            mutation: {
              dependsOn: ["test", "build", "lib#mutation"],
              run: { command: "mutation", kind: "shell" },
            },
            test: { run: { command: "test", kind: "shell" } },
          },
          lib: {
            mutation: {
              dependsOn: ["test"],
              run: { command: "mutation", kind: "shell" },
            },
            test: { run: { command: "test", kind: "shell" } },
          },
        },
        version: 2,
      };
      // Act
      const graph = compileGraph(workflow, target);

      // Assert
      expect(
        graph
          .values()
          .filter((task) => task.run !== undefined)
          .map((task) => task.id)
          .toArray(),
      ).toEqual(members);
      expect(graph.get(taskReference("app", "mutation"))?.dependsOn).toEqual(
        target === "mutation" ? [taskReference("lib", "mutation")] : [],
      );
      expect(graph.keys().toArray()).not.toContain("app#build");
      expect(
        graph.get(taskReference("lib", "mutation"))?.dependsOn ?? [],
      ).toEqual([]);
    },
  );

  it("keeps command ordering when an aggregate selects both commands", () => {
    // Arrange
    const workflow: RunnerConfig = {
      packages: {
        ".": {
          mutation: {
            dependsOn: ["test"],
            run: { kind: "npm", script: "mutation" },
          },
          test: { run: { kind: "npm", script: "test" } },
          "test:all": { dependsOn: ["test", "mutation"] },
        },
      },
      version: 2,
    };
    // Act
    const graph = compileGraph(workflow, "test:all");

    // Assert
    expect(graph.keys().toArray()).toEqual(["test", "mutation", "test:all"]);
    expect(graph.get(taskReference(".", "mutation"))?.dependsOn).toEqual([
      taskReference(".", "test"),
    ]);
  });

  it.each([
    { bad: { dependsOn: ["missing"] }, error: "Unknown task: missing" },
    {
      bad: { dependsOn: ["bad"] },
      error: "Circular task dependency: bad -> bad",
    },
  ])(
    "rejects invalid definitions outside the selected target: $error",
    ({ bad, error }) => {
      // Arrange & Act & Assert
      expect(() =>
        compileGraph(
          { packages: { ".": { ...tasks, bad } }, version: 2 },
          "end",
        ),
      ).toThrow(error);
    },
  );

  it("keeps required and optional npm commands from the config", () => {
    // Arrange
    const commands: RunnerConfig = {
      packages: {
        ".": {
          docs: { run: { kind: "npm", optional: true, script: "docs" } },
          test: { run: { kind: "npm", script: "test" } },
        },
      },
      version: 2,
    };
    // Act & Assert
    expect(compileGraph(commands, "docs").values().next().value?.run).toEqual({
      kind: "npm",
      optional: true,
      script: "docs",
    });
    expect(compileGraph(commands, "test").values().next().value?.run).toEqual({
      kind: "npm",
      script: "test",
    });
    expect(() => compileGraph(config, "absent")).toThrow(
      "Unknown task: absent",
    );
  });

  it("resolves local, cross-package, root references and aliases without collisions", () => {
    // Arrange
    const scoped: RunnerConfig = {
      packages: {
        ".": {
          build: { dependsOn: ["apps/web#build"] },
          "build:web": { dependsOn: ["apps/web#build"] },
          prepare: {},
        },
        "apps/web": {
          build: { dependsOn: ["compile"] },
          compile: { dependsOn: [".#prepare", "packages/lib#build"] },
        },
        "packages/lib": { build: {} },
      },
      version: 2,
    };
    // Act
    const graph = compileGraph(scoped, "build");
    // Assert
    expect(graph.keys().toArray()).toEqual([
      "prepare",
      "packages/lib#build",
      "apps/web#compile",
      "apps/web#build",
      "build",
    ]);
    expect(compileGraph(scoped, "build:web").keys().toArray().at(-1)).toBe(
      "build:web",
    );
    expect(() =>
      compileGraph(
        { packages: { ".": scoped.packages["."] ?? {} }, version: 2 },
        "build",
      ),
    ).toThrow("Unknown task: apps/web#build");
  });

  it("detects cross-package cycles", () => {
    // Arrange
    const cyclic: RunnerConfig = {
      packages: {
        ".": { build: { dependsOn: ["lib#build"] } },
        lib: { build: { dependsOn: [".#build"] } },
      },
      version: 2,
    };
    // Act & Assert
    expect(() => compileGraph(cyclic, "build")).toThrow(
      "build -> lib#build -> build",
    );
  });

  it.each(["", " ", "a#b"])(
    "rejects ambiguous local task names: %s",
    (name) => {
      // Arrange & Act & Assert
      expect(() => taskReference(".", name)).toThrow("Invalid local task name");
    },
  );

  it("rejects ambiguous package paths and malformed qualified references", () => {
    // Arrange & Act & Assert
    expect(() => taskReference("a#b", "build")).toThrow("Invalid package path");
    expect(() => resolveTaskReference(".", "#build")).toThrow(
      "Missing package",
    );
    expect(() => resolveTaskReference(".", "lib#")).toThrow(
      "Invalid local task name",
    );
    expect(resolveTaskReference("apps/web", ".#build")).toBe("build");
  });

  it("trusts configured npm script references without inspecting package manifests", () => {
    // Arrange
    const workflow: RunnerConfig = {
      packages: {
        ".": {
          check: { run: { kind: "npm", script: "task-runner run check" } },
        },
      },
      version: 2,
    };

    // Act
    const graph = compileGraph(workflow, "check");

    // Assert
    expect(graph.values().next().value?.run).toEqual({
      kind: "npm",
      script: "task-runner run check",
    });
  });
});
