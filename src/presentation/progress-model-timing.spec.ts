import { stripVTControlCharacters } from "node:util";
import { make } from "ts-brand";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompiledTask, TaskEvent, TaskId, TaskStatus } from "../domain";

import { ProgressModel } from "./progress-model";

const id = make<TaskId>();
const task = (
  name: string,
  dependencies: string[] = [],
  command = true,
  packagePath = ".",
): CompiledTask => ({
  dependsOn: dependencies.map((dependency) => id(dependency)),
  id: id(name),
  package: packagePath,
  skip: false,
  ...(command && { run: { kind: "npm", script: name } as const }),
});
const graphFor = (...tasks: CompiledTask[]) =>
  new Map(tasks.map((item) => [item.id, item]));
const event = (
  name: string,
  status: TaskStatus,
  durationMs?: number,
): TaskEvent => ({
  package: ".",
  status,
  taskId: id(name),
  ...(durationMs !== undefined && { durationMs }),
});

afterEach(() => vi.useRealTimers());

describe("nested progress model", () => {
  it.each(["blocked", "cancelled", "failed"] as const)(
    "freezes group duration on %s",
    (status) => {
      // Arrange
      vi.useFakeTimers();
      const model = new ProgressModel(
        graphFor(task("root", ["child"], false), task("child")),
        "root",
      );
      model.update(event("child", "running"));
      vi.advanceTimersByTime(1200);
      // Act
      model.update(event("root", status));
      vi.advanceTimersByTime(5000);
      // Assert
      expect(model.frame(0, 20)).toContain(`root (${status}, 1.2s)`);
    },
  );

  it.each(["succeeded", "skipped", "blocked", "cancelled"] as const)(
    "reports zero for a group that becomes %s without starting work",
    (status) => {
      // Arrange
      vi.useFakeTimers();
      const model = new ProgressModel(
        graphFor(task("empty", [], false)),
        "empty",
      );
      vi.advanceTimersByTime(2000);
      // Act
      model.update(event("empty", status));
      vi.advanceTimersByTime(2000);
      // Assert
      expect(model.frame(0, 20)).toContain(`empty (${status}, 0.0s)`);
    },
  );

  it.each([
    ["pending", "\u{25A1}", 90],
    ["ready", "\u{203A}", 33],
    ["running", "\u{280B}", 36],
    ["succeeded", "\u{2714}", 32],
    ["failed", "\u{2716}", 31],
    ["skipped", "\u{2193}", 90],
    ["blocked", "\u{26A0}", 33],
    ["cancelled", "\u{25A0}", 35],
  ] as const)(
    "styles %s with its own icon and color",
    (status, icon, color) => {
      // Arrange
      const model = new ProgressModel(graphFor(task("check")), "check");
      model.update(event("check", status, 100));
      // Act
      const colored = model.frame(0, 20, { color: true });
      const uncolored = model.frame(0, 20, { color: false });
      // Assert
      expect(colored).toContain(`\u{1B}[${String(color)}m${icon}\u{1B}[39m`);
      expect(stripVTControlCharacters(colored)).toBe(uncolored);
      expect(uncolored).toBe(`${icon} check (${status}, 0.1s)`);
    },
  );

  it("animates the dot spinner and preserves colors in height-limited nested output", () => {
    // Arrange
    const model = new ProgressModel(
      graphFor(
        task("root", ["idle", "active", "other"], false),
        task("idle"),
        task("active"),
        task("other"),
      ),
      "root",
    );
    model.update(event("active", "running", 0));
    // Act
    const frames = Array.from({ length: 11 }, (_, frame) =>
      model.frame(frame, 2, { color: true }),
    );
    // Assert
    expect(frames[0]).toContain("\u{1B}[36m\u{280B}\u{1B}[39m root");
    expect(frames[1]).toContain("  \u{1B}[36m\u{2819}\u{1B}[39m active");
    expect(frames[0]).toContain("2 more tasks");
    expect(new Set(frames.slice(0, 10)).size).toBe(10);
    expect(frames[10]).toBe(frames[0]);
  });

  it("nests groups, orders command prerequisites, and displays shared work once", () => {
    // Arrange
    const model = new ProgressModel(
      graphFor(
        task("validate", ["build", "pack", "test"], false),
        task("build", ["compile"], false),
        task("compile", ["clean"]),
        task("clean"),
        task("pack", ["build"], false),
        task("test", [], true, "packages/lib"),
      ),
      "validate",
      false,
    );
    // Act
    const frame = model.frame(0, 30);
    // Assert
    expect(frame).toBe(
      [
        ". validate (pending)",
        "  . build (pending)",
        "    . clean (pending)",
        "    . compile (pending)",
        "  . pack (pending)",
        "  . packages/lib > test (pending)",
      ].join("\n"),
    );
  });

  it("reports zero command tasks for an empty group", () => {
    // Arrange
    const model = new ProgressModel(
      graphFor(task("group", [], false)),
      "group",
    );
    // Act
    model.update(event("group", "succeeded"));
    // Assert
    expect(model.summary()).toBe("Tasks: 0");
  });
});
