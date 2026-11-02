import { make } from "ts-brand";
import { describe, expect, it } from "vitest";

import type { CompiledTask, TaskId } from "./types";

import { qualifiedTaskName } from "./task-name";

const task: CompiledTask = {
  dependsOn: [],
  id: make<TaskId>()("apps/automation#mutation"),
  package: "apps/automation",
  run: { kind: "npm", script: "mutation" },
  skip: false,
};

describe("qualifiedTaskName", () => {
  it("uses the last package path segment when it is unique", () => {
    // Arrange
    const packagePaths = [".", "apps/automation", "apps/back"];
    // Act
    const name = qualifiedTaskName(task, packagePaths);
    // Assert
    expect(name).toBe("automation:mutation");
  });

  it("uses the full package path when suffixes are ambiguous", () => {
    // Arrange
    const packagePaths = [".", "apps/automation", "packages/automation"];
    // Act
    const name = qualifiedTaskName(task, packagePaths);
    // Assert
    expect(name).toBe("apps/automation:mutation");
  });

  it("does not qualify root tasks", () => {
    // Arrange
    const rootTask: CompiledTask = { ...task, package: "." };
    // Act
    const name = qualifiedTaskName(rootTask, [".", "apps/automation"]);
    // Assert
    expect(name).toBe("mutation");
  });
});
