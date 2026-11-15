import { make } from "ts-brand";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompiledTask, TaskEvent, TaskId, TaskStatus } from "../domain";

import { ProgressModel } from "./progress-model";
import {
  groupRealDuration,
  type ProgressRowState,
  progressStatus,
} from "./progress-model-group-timing";

const id = make<TaskId>();
const task = (
  name: string,
  dependencies: string[] = [],
  command = true,
): CompiledTask => ({
  dependsOn: dependencies.map((dependency) => id(dependency)),
  id: id(name),
  package: ".",
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

describe("group progress timing", () => {
  it("defaults missing display timing entries safely", () => {
    // Arrange
    const group = task("group", [], false);
    const command = task("command");
    const commandTasks = new Set<TaskId>();
    const events = new Map<TaskId, TaskEvent>();
    const groupChildren = new Map<TaskId, ReadonlySet<TaskId>>();
    const started = new Map<TaskId, number>();
    const state: ProgressRowState = {
      commandDurations: new Map(),
      commandTasks,
      events,
      groupChildren,
      groupDescendants: new Map(),
      groupDurations: new Map(),
      groupRealDurations: new Map(),
      packagePaths: ["."],
      started,
    };
    const row = {
      children: [],
      depth: 0,
      hidden: false,
      scope: ".",
      task: group,
    };

    // Act
    expect(groupRealDuration(group.id, 100, state)).toBe(0);
    groupChildren.set(group.id, new Set([command.id]));
    commandTasks.add(command.id);
    events.set(command.id, event("command", "running"));
    expect(groupRealDuration(group.id, 100, state)).toBe(0);
    started.set(group.id, 0);
    expect(progressStatus(row, state)).toBe("waiting");

    // Assert
    expect(events.get(command.id)?.status).toBe("running");
  });

  it("starts displayed group timing only when its subtree starts", () => {
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
    expect(live).toContain("validate (⧗ 1.2s, ∑ 2.4s)");
    expect(live).toContain("build (⧗ 1.2s, ∑ 1.2s)");
    expect(live).toContain("pack");
    expect(completedGroups).toContain("build (⧗ 2.0s, ∑ 2.0s)");
    expect(completedGroups).toContain("pack (⧗ 1.0s, ∑ 1.0s)");
    expect(completedGroups).toContain("validate (⧗ 3.5s, ∑ 6.5s)");
    expect(model.frame(0, { limit: 30 })).toBe("+ validate (⧗ 4.5s, ∑ 7.5s)");
    expect(model.eventLine(event("pack", "succeeded"))).toBe(
      "  + pack (⧗ 1.0s, ∑ 1.0s)",
    );
  });

  it("shows a started group waiting between commands", () => {
    // Arrange
    vi.useFakeTimers();
    const model = new ProgressModel(
      graphFor(
        task("root", ["phase"], false),
        task("phase", ["first", "next"], false),
        task("first"),
        task("next", ["first"]),
      ),
      "root",
      false,
    );
    model.update(event("first", "running"));
    vi.advanceTimersByTime(900);
    model.update(event("first", "succeeded", 900));
    const waiting = model.frame(0, { limit: 20 });
    const summary = model.summary();
    vi.advanceTimersByTime(500);
    model.update(event("next", "running"));
    vi.advanceTimersByTime(1000);
    const running = model.frame(0, { limit: 20 });
    model.update(event("next", "succeeded", 1000));
    model.update(event("phase", "succeeded"));
    model.update(event("root", "succeeded"));

    // Assert
    expect(waiting).toContain("… root (⧗ 0.9s, ∑ 0.9s)");
    expect(waiting).toContain("  … phase (⧗ 0.9s, ∑ 0.9s)");
    expect(waiting).toContain("    . next");
    expect(summary).toBe("Tasks: 2 | pending: 1 | succeeded: 1");
    expect(running).toContain("| root (⧗ 2.4s, ∑ 1.9s)");
    expect(model.frame(0, { limit: 20 })).toContain("+ root (⧗ 2.4s, ∑ 1.9s)");
  });
});
