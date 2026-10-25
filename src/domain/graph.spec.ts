import { describe, expect, it } from "vitest";
import { compileGraph } from "./graph.js";
import { resolveTaskReference, taskReference } from "./task-reference.js";
import type { RunnerConfig, TaskDefinition } from "./types.js";

const tasks: Record<string, TaskDefinition> = {
  start: { run: { kind: "npm", script: "check" } },
  left: { dependsOn: ["start"] },
  right: { dependsOn: ["start"] },
  end: { dependsOn: ["left", "right"] },
  unrelated: {},
};
const config: RunnerConfig = { version: 2, packages: { ".": tasks } };
const scripts = new Map([[".", { check: "echo checked" }]]);

describe("graph compilation", () => {
  it("selects a diamond graph once without unrelated work", () => {
    // Arrange & Act
    const graph = compileGraph(config, "end", scripts);
    // Assert
    expect([...graph.keys()]).toEqual(["start", "left", "right", "end"]);
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
          { version: 2, packages: { ".": { ...tasks, bad } } },
          "end",
          scripts,
        ),
      ).toThrow(error);
    },
  );

  it("skips only explicitly optional missing scripts", () => {
    // Arrange
    const optional: RunnerConfig = {
      version: 2,
      packages: {
        ".": { docs: { run: { kind: "npm", script: "docs", optional: true } } },
      },
    };
    // Act & Assert
    expect([...compileGraph(optional, "docs", scripts).values()][0]?.skip).toBe(
      true,
    );
    expect(() => compileGraph(config, "absent", scripts)).toThrow(
      "Unknown task: absent",
    );
  });

  it("resolves local, cross-package, root references and aliases without collisions", () => {
    // Arrange
    const scoped: RunnerConfig = {
      version: 2,
      packages: {
        ".": {
          prepare: {},
          build: { dependsOn: ["apps/web#build"] },
          "build:web": { dependsOn: ["apps/web#build"] },
        },
        "apps/web": {
          build: { dependsOn: ["compile"] },
          compile: { dependsOn: [".#prepare", "packages/lib#build"] },
        },
        "packages/lib": { build: {} },
      },
    };
    const manifests = new Map([
      [".", {}],
      ["apps/web", {}],
      ["packages/lib", {}],
    ]);
    // Act
    const graph = compileGraph(scoped, "build", manifests);
    // Assert
    expect([...graph.keys()]).toEqual([
      "prepare",
      "packages/lib#build",
      "apps/web#compile",
      "apps/web#build",
      "build",
    ]);
    expect(
      [...compileGraph(scoped, "build:web", manifests).keys()].at(-1),
    ).toBe("build:web");
    expect(() => compileGraph(scoped, "build", scripts)).toThrow(
      "Unknown package: apps/web",
    );
  });

  it("detects cross-package cycles", () => {
    // Arrange
    const cyclic: RunnerConfig = {
      version: 2,
      packages: {
        ".": { build: { dependsOn: ["lib#build"] } },
        lib: { build: { dependsOn: [".#build"] } },
      },
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
