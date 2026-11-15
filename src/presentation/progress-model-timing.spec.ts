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
      expect(model.frame(0, { limit: 20 })).toContain(`root (${status}, 1.2s)`);
    },
  );

  it.each(["succeeded", "blocked", "cancelled"] as const)(
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
      expect(model.frame(0, { limit: 20 })).toContain(
        `empty (${status}, 0.0s)`,
      );
    },
  );

  it.each([
    ["pending", "\u{25A1}", 90],
    ["ready", "\u{203A}", 33],
    ["running", "\u{280B}", 36],
    ["succeeded", "\u{2714}", 32],
    ["failed", "\u{2716}", 31],
    ["blocked", "\u{26A0}", 33],
    ["cancelled", "\u{25A0}", 35],
  ] as const)(
    "styles %s with its own icon and color",
    (status, icon, color) => {
      // Arrange
      const model = new ProgressModel(graphFor(task("check")), "check");
      model.update(event("check", status, 100));
      // Act
      const colored = model.frame(0, {
        appearance: { color: true },
        limit: 20,
      });
      const uncolored = model.frame(0, {
        appearance: { color: false },
        limit: 20,
      });
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
      model.frame(frame, { appearance: { color: true }, limit: 2 }),
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
    const frame = model.frame(0, { limit: 30 });
    // Assert
    expect(frame).toBe(
      [
        ". validate (pending)",
        "  . build (pending)",
        "    . clean (pending)",
        "    . compile (pending)",
        "  . pack (pending)",
        "  . lib:test (pending)",
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

  it("starts group activity and timing only when its displayed subtree starts", () => {
    // Arrange
    vi.useFakeTimers();
    const model = new ProgressModel(
      graphFor(
        task("validate", ["build", "pack", "test"], false),
        task("build", ["compile"], false),
        task("compile", ["clean"]),
        task("clean"),
        task("pack", ["build", "artifact"], false),
        task("artifact", ["build"]),
        task("test"),
      ),
      "validate",
    );
    vi.advanceTimersByTime(1000);
    // Act
    model.update(event("clean", "running"));
    model.update(event("test", "running"));
    vi.advanceTimersByTime(1200);
    model.update(event("clean", "succeeded", 1200));
    model.update(event("compile", "running"));
    const live = model.frame(0, { limit: 30 });
    vi.advanceTimersByTime(800);
    model.update(event("compile", "succeeded", 800));
    model.update(event("build", "succeeded"));
    vi.advanceTimersByTime(500);
    model.update(event("artifact", "running"));
    vi.advanceTimersByTime(1000);
    model.update(event("artifact", "succeeded", 1000));
    model.update(event("pack", "succeeded"));
    const completedGroups = model.frame(0, { limit: 30 });
    vi.advanceTimersByTime(1000);
    model.update(event("test", "succeeded", 4500));
    model.update(event("validate", "succeeded"));
    vi.advanceTimersByTime(10_000);
    // Assert
    expect(live).toContain("validate (running, 1.2s)");
    expect(live).toContain("build (running, 1.2s)");
    expect(live).toContain("pack (pending)");
    expect(completedGroups).toContain("build (succeeded, 2.0s)");
    expect(completedGroups).toContain("pack (succeeded, 1.0s)");
    expect(completedGroups).toContain("validate (running, 3.5s)");
    expect(model.frame(0, { limit: 30 })).toBe("+ validate (succeeded, 4.5s)");
    expect(model.eventLine(event("pack", "succeeded"))).toBe(
      "  + pack (succeeded, 1.0s)",
    );
  });
});
