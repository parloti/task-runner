import path from "node:path";
import { make } from "ts-brand";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompiledTask, TaskId } from "../domain";

import { taskLogPath } from "./task-log";

const task: CompiledTask = {
  dependsOn: [],
  id: make<TaskId>()("apps/automation#validation:test"),
  package: "apps/automation",
  run: { kind: "npm", script: "test" },
  skip: false,
};

afterEach(() => vi.restoreAllMocks());

describe("task output paths", () => {
  it("names logs by full workspace task and a safe ISO timestamp", () => {
    // Arrange & Act
    const log = taskLogPath("logs", task);
    // Assert
    expect(path.dirname(log)).toBe("logs");
    expect(path.basename(log)).toMatch(
      /^apps-automation-test-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.log$/,
    );
    expect(log).not.toContain("validation");
  });

  it("keeps colliding names unique even for concurrent executors and backwards clocks", () => {
    // Arrange
    vi.spyOn(Date, "now").mockReturnValue(0);
    // Act
    const first = taskLogPath("logs", task);
    const second = taskLogPath("logs", task);
    // Assert
    expect(first).not.toBe(second);
    expect(first < second).toBe(true);
  });

  it.each([
    { expected: "a-b-", name: '../../a\\b:*?"<>|\u{1B}[2J\n' },
    { expected: "task-", name: "..." },
    { expected: "CON-", name: "CON" },
    { expected: "task-", name: "\u{754C}".repeat(150) },
    { expected: "a".repeat(120) + "-", name: "a".repeat(250) },
  ])(
    "normalizes unsafe or oversized root task names: $expected",
    ({ expected, name }) => {
      // Arrange
      const definition: CompiledTask = {
        ...task,
        id: make<TaskId>()(name),
        package: ".",
        run: { command: "unused", kind: "shell" },
      };
      // Act
      const log = taskLogPath("logs", definition);
      // Assert
      expect(path.dirname(log)).toBe("logs");
      expect(path.basename(log).startsWith(expected)).toBe(true);
      expect(path.basename(log)).not.toMatch(/[<>:"/\\|?*\p{Cc}]/u);
    },
  );
});
