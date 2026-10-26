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
const scripts = new Map([[".", { check: "echo checked" }]]);

describe("graph compilation", () => {
  it("selects a diamond graph once without unrelated work", () => {
    // Arrange & Act
    const graph = compileGraph(config, "end", scripts);
    // Assert
    expect(graph.keys().toArray()).toEqual(["start", "left", "right", "end"]);
  });

  it("skips direct command prerequisites but retains group prerequisites", () => {
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
    const workflowScripts = new Map([
      [".", { mutation: "stryker", prepare: "prepare", test: "vitest" }],
    ]);

    // Act
    const graph = compileGraph(workflow, "mutation", workflowScripts);

    // Assert
    expect(graph.keys().toArray()).toEqual(["prepare", "setup", "mutation"]);
    expect(graph.get(taskReference(".", "mutation"))?.dependsOn).toEqual([
      taskReference(".", "setup"),
    ]);
  });

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
    const workflowScripts = new Map([
      [".", { mutation: "stryker", test: "vitest" }],
    ]);

    // Act
    const graph = compileGraph(workflow, "test:all", workflowScripts);

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
    {
      bad: { run: { kind: "npm" as const, script: "missing" } },
      error: "Missing required npm script",
    },
  ])(
    "rejects invalid definitions outside the selected target: $error",
    ({ bad, error }) => {
      // Arrange & Act & Assert
      expect(() =>
        compileGraph(
          { packages: { ".": { ...tasks, bad } }, version: 2 },
          "end",
          scripts,
        ),
      ).toThrow(error);
    },
  );

  it("skips only explicitly optional missing scripts", () => {
    // Arrange
    const optional: RunnerConfig = {
      packages: {
        ".": { docs: { run: { kind: "npm", optional: true, script: "docs" } } },
      },
      version: 2,
    };
    // Act & Assert
    expect(
      compileGraph(optional, "docs", scripts).values().next().value?.skip,
    ).toBe(true);
    expect(() => compileGraph(config, "absent", scripts)).toThrow(
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
    const manifests = new Map([
      [".", {}],
      ["apps/web", {}],
      ["packages/lib", {}],
    ]);
    // Act
    const graph = compileGraph(scoped, "build", manifests);
    // Assert
    expect(graph.keys().toArray()).toEqual([
      "prepare",
      "packages/lib#build",
      "apps/web#compile",
      "apps/web#build",
      "build",
    ]);
    expect(
      compileGraph(scoped, "build:web", manifests).keys().toArray().at(-1),
    ).toBe("build:web");
    expect(() => compileGraph(scoped, "build", scripts)).toThrow(
      "Unknown package: apps/web",
    );
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
    expect(() =>
      compileGraph(
        cyclic,
        "build",
        new Map([
          [".", {}],
          ["lib", {}],
        ]),
      ),
    ).toThrow("build -> lib#build -> build");
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

  it("rejects recursive npm wrappers", () => {
    // Arrange & Act & Assert
    expect(() =>
      compileGraph(
        config,
        "end",
        new Map([[".", { check: "task-runner run check" }]]),
      ),
    ).toThrow("Recursive runner wrapper");
  });
});
