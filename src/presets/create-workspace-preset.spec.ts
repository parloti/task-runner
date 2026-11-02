import { describe, expect, it } from "vitest";

import { compileGraph } from "../domain";
import { createWorkspacePreset } from "./create-workspace-preset";

describe("preset task selection", () => {
  it.each([
    {
      commands: ["packages/lib#mutation", "apps/web#mutation"],
      target: "mutation",
    },
    { commands: ["apps/web#mutation"], target: "mutation:web" },
    { commands: ["docs"], target: "docs" },
    { commands: ["apps/web#pack"], target: "pack:web" },
  ])("starts $target without earlier phases", ({ commands, target }) => {
    // Arrange
    const preset = createWorkspacePreset([
      { name: "root", path: "." },
      { name: "lib", path: "packages/lib", utility: true },
      { internalDependencies: ["lib"], name: "web", path: "apps/web" },
    ]);

    // Act
    const graph = compileGraph(
      preset.config,
      target,
      new Map(Object.entries(preset.scripts)),
    );

    // Assert
    expect(
      graph
        .values()
        .filter((task) => task.run !== undefined)
        .map((task) => task.id)
        .toArray(),
    ).toEqual(commands);
    expect(
      graph
        .values()
        .filter((task) => task.run !== undefined)
        .every((task) => task.dependsOn.length === 0),
    ).toBe(true);
  });

  it("explicitly selects internal builds and all steps for a workspace build alias", () => {
    // Arrange
    const preset = createWorkspacePreset([
      { name: "root", path: "." },
      { internalDependencies: ["lib"], name: "web", path: "apps/web" },
      { name: "lib", path: "packages/lib", utility: true },
    ]);

    // Act
    const graph = compileGraph(
      preset.config,
      "build:web",
      new Map(Object.entries(preset.scripts)),
    );

    // Assert
    expect(graph.keys().toArray()).toEqual([
      "packages/lib#clean",
      "packages/lib#compile",
      "packages/lib#resolve-paths",
      "packages/lib#build",
      "apps/web#clean",
      "apps/web#compile",
      "apps/web#resolve-paths",
      "apps/web#build",
      "build:web",
    ]);
    expect(
      graph.values().find((task) => task.id === "apps/web#clean")?.dependsOn,
    ).toEqual(["packages/lib#build"]);
  });
});
