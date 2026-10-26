import { make } from "ts-brand";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompiledTask, TaskEvent, TaskId, TaskStatus } from "../domain";

import { compileGraph } from "../domain";
import { createWorkspacePreset } from "../presets";
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
  it.each<TaskStatus>([
    "pending",
    "ready",
    "running",
    "succeeded",
    "failed",
    "skipped",
    "blocked",
    "cancelled",
  ])(
    "renders the %s state and terminal duration without raw preset IDs",
    (status) => {
      // Arrange
      const name = "build";
      const model = new ProgressModel(graphFor(task(name, [], false)), name);
      // Act
      model.update(event(name, status, 1234));
      // Assert
      expect(model.frame(0, 20)).toContain(`build (${status}, 1.2s)`);
      expect(model.frame(0, 20)).not.toContain('["."');
      expect(model.eventLine(event(name, status))).toBe(
        status === "pending" || status === "ready"
          ? undefined
          : model.frame(0, 20),
      );
    },
  );

  it("shows live durations and animates running groups without changing scheduler states", () => {
    // Arrange
    vi.useFakeTimers();
    const model = new ProgressModel(
      graphFor(task("root", ["child"], false), task("child")),
      "root",
    );
    model.update(event("child", "running"));
    // Act
    vi.advanceTimersByTime(1200);
    // Assert
    expect(model.frame(1, 20)).toBe(
      "/ root (running, 1.2s)\n  / child (running, 1.2s)",
    );
    expect(model.frame(2, 20)).toContain("- child");
    expect(model.frame(3, 20)).toContain("\\ child");
  });

  it("shows aggregate activity between commands and collapses completed groups", () => {
    // Arrange
    vi.useFakeTimers();
    const model = new ProgressModel(
      graphFor(
        task("root", ["child", "next"], false),
        task("child"),
        task("next"),
      ),
      "root",
    );
    model.update(event("child", "running"));
    vi.advanceTimersByTime(1200);
    model.update(event("child", "succeeded", 1200));
    // Act
    const active = model.frame(0, 20);
    model.update(event("root", "succeeded"));
    // Assert
    expect(active).toContain("| root (running, 1.2s)");
    expect(model.frame(0, 20)).toBe("+ root (succeeded, 1.2s)");
  });

  it("uses literal shell task IDs and sanitizes terminal controls in all labels", () => {
    // Arrange
    const model = new ProgressModel(
      graphFor({
        ...task("shell\u{1B}[2J\nname", [], false, "pkg\u{7}"),
        run: { command: "echo ok", kind: "shell" },
      }),
      "shell\u{1B}[2J\nname",
    );
    // Act
    const frame = model.frame(0, 20);
    // Assert
    expect(frame).toBe(". pkg  > shell name (pending)");
    expect(frame).not.toContain("\u{1B}");
  });

  it.each(["42", '["only"]', '["pkg",42]', '{"label":"x"}', "custom:task"])(
    "keeps literal task names: %s",
    (name) => {
      // Arrange
      const model = new ProgressModel(graphFor(task(name, [], false)), name);
      // Act & Assert
      expect(model.frame(0, 20)).toContain(name);
    },
  );

  it("retains active branches and nesting when the terminal has too few rows", () => {
    // Arrange
    const model = new ProgressModel(
      graphFor(
        task("root", ["idle", "group"], false),
        task("idle"),
        task("group", ["first", "active"], false),
        task("first"),
        task("active"),
      ),
      "root",
    );
    model.update(event("active", "running"));
    // Act
    const frame = model.frame(0, 3);
    // Assert
    expect(frame).toContain("root (running,");
    expect(frame).toContain("  | group (running,");
    expect(frame).toContain("    | active (running");
    expect(frame).toContain("2 more tasks");
    expect(frame.split("\n")).toHaveLength(4);
    expect(model.frame(0, 1).split("\n").length).toBeLessThanOrEqual(2);
  });

  it("places shared builds under their own validation groups regardless of first consumer", () => {
    // Arrange
    const preset = createWorkspacePreset([
      { name: "root", path: "." },
      {
        internalDependencies: ["contract"],
        name: "automation",
        path: "apps/automation",
      },
      { internalDependencies: ["contract"], name: "back", path: "apps/back" },
      { name: "contract", path: "packages/contract", utility: true },
    ]);
    const target = "validate";
    const graph = compileGraph(
      preset.config,
      target,
      new Map(Object.entries(preset.scripts)),
    );
    const model = new ProgressModel(graph, target, false);
    // Act
    const frame = model.frame(0);
    for (const task of graph.values())
      model.update({
        package: task.package,
        status: "blocked",
        taskId: task.id,
      });
    const failed = model.frame(0);
    // Assert
    expect(frame).not.toContain(" > ");
    expect(frame.match(/^ {4}\. build /gm)).toHaveLength(3);
    expect(frame.indexOf("validate:contract")).toBeLessThan(
      frame.lastIndexOf("clean (pending)"),
    );
    expect(frame).not.toMatch(/^ {2}\. build /m);
    expect(frame.match(/clean \(pending\)/g)).toHaveLength(3);
    expect(failed.match(/clean \(blocked\)/g)).toHaveLength(3);
    expect(
      model.eventLine({ package: ".", status: "blocked", taskId: id("build") }),
    ).toBeUndefined();
  });

  it("keeps dependencies visible when their workspace validation group is not selected", () => {
    // Arrange
    const preset = createWorkspacePreset([
      { name: "root", path: "." },
      { internalDependencies: ["lib"], name: "web", path: "apps/web" },
      { name: "lib", path: "packages/lib", utility: true },
    ]);
    const graph = compileGraph(
      preset.config,
      "validate:web",
      new Map(Object.entries(preset.scripts)),
    );
    // Act
    const frame = new ProgressModel(graph, "validate:web", false).frame(0);
    // Assert
    expect(frame).toContain("    . packages/lib > build (pending)");
    expect(frame).toContain("      . clean (pending)");
    expect(frame.match(/clean \(pending\)/g)).toHaveLength(2);
  });

  it("defaults to 100 task rows and applies explicit caps without hiding extra tasks silently", () => {
    // Arrange
    const names = Array.from(
      { length: 110 },
      (_, index) => `task-${String(index)}`,
    );
    const model = new ProgressModel(
      graphFor(task("root", names, false), ...names.map((name) => task(name))),
      "root",
      false,
    );
    // Act
    const frame = model.frame(0);
    const limited = model.frame(0, 7);
    // Assert
    expect(frame.split("\n")).toHaveLength(101);
    expect(frame).toContain("... 11 more tasks");
    expect(limited.split("\n")).toHaveLength(8);
    expect(limited).toContain("... 104 more tasks");
  });

  it("reports invalid presentation plans and unknown task events explicitly", () => {
    // Arrange
    const model = new ProgressModel(graphFor(task("root")), "root");
    // Act & Assert
    expect(() => new ProgressModel(new Map(), "missing")).toThrow(
      "Missing progress target",
    );
    expect(
      () => new ProgressModel(graphFor(task("root", ["missing"])), "root"),
    ).toThrow("Missing progress dependency");
    expect(() => {
      model.update(event("missing", "running"));
    }).toThrow("Unknown progress task");
    expect(() => model.eventLine(event("missing", "failed"))).toThrow(
      "Unknown progress task",
    );
  });
});
