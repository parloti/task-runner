import path from "node:path";
import { make } from "ts-brand";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompiledTask, TaskId } from "../domain/types.js";
import { taskLogPath } from "./task-log.js";

const task: CompiledTask = {
  id: make<TaskId>()("apps/automation#validation:test"),
  package: "apps/automation",
  dependsOn: [],
  skip: false,
  run: { kind: "npm", script: "test" },
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
    { name: '../../a\\b:*?"<>|\u001b[2J\n', expected: "a-b-" },
    { name: "...", expected: "task-" },
    { name: "CON", expected: "CON-" },
    { name: "\u754c".repeat(150), expected: "task-" },
    { name: "a".repeat(250), expected: "a".repeat(120) + "-" },
  ])(
    "normalizes unsafe or oversized root task names: $expected",
    ({ name, expected }) => {
      // Arrange
      const definition: CompiledTask = {
        ...task,
        package: ".",
        id: make<TaskId>()(name),
        run: { kind: "shell", command: "unused" },
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
