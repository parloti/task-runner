import { make } from "ts-brand";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompiledTask, TaskEvent, TaskId, TaskStatus } from "../domain";

import { sharedBuildTasks } from "./__tests__";
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
  ...(command && {
    run: {
      kind: "npm",
      script: name.startsWith(`${packagePath}#`)
        ? name.slice(packagePath.length + 1)
        : name,
    } as const,
  }),
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
  it("formats command labels in and across workspace scopes", () => {
    const command = task(
      "apps/automation#mutation",
      [],
      true,
      "apps/automation",
    );
    const scopedGroup = task(
      "validate:automation",
      ["apps/automation#mutation"],
      false,
    );
    const scoped = new ProgressModel(
      graphFor(scopedGroup, command),
      scopedGroup.id,
      false,
    ).frame(0);
    const root = task("root", ["apps/automation#mutation"], false);
    const qualified = new ProgressModel(
      graphFor(root, command),
      root.id,
      false,
    ).frame(0);

    // Assert
    expect(scoped).toContain("  . mutation");
    expect(qualified).toContain("automation:mutation");
  });

  it.each<TaskStatus>([
    "pending",
    "ready",
    "running",
    "succeeded",
    "failed",
    "blocked",
    "cancelled",
  ])(
    "renders the %s state and terminal duration without raw preset IDs",
    (status) => {
      // Arrange
      const name = "build";
      const model = new ProgressModel(graphFor(task(name)), name);
      model.update(event(name, status, 1234));
      // Assert
      expect(model.frame(0, { limit: 20 })).toContain("build (1.2s)");
      expect(model.frame(0, { limit: 20 })).not.toContain(status);
      expect(model.frame(0, { limit: 20 })).not.toContain('["."');
      expect(model.eventLine(event(name, status))).toBe(
        status === "pending" || status === "ready"
          ? undefined
          : model.frame(0, { limit: 20 }),
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
    vi.advanceTimersByTime(1200);
    // Assert
    expect(model.frame(1, { limit: 20 })).toBe(
      "/ root (⧗ 1.2s, ∑ 1.2s)\n  / child (1.2s)",
    );
    expect(model.frame(2, { limit: 20 })).toContain("- child");
    expect(model.frame(3, { limit: 20 })).toContain("\\ child");
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
    const active = model.frame(0, { limit: 20 });
    model.update(event("root", "succeeded"));
    // Assert
    expect(active).toContain("… root (⧗ 1.2s, ∑ 1.2s)");
    expect(model.frame(0, { limit: 20 })).toBe("+ root (⧗ 1.2s, ∑ 1.2s)");
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
    const frame = model.frame(0, { limit: 20 });
    // Assert
    expect(frame).toBe(". pkg :shell name");
    expect(frame).not.toContain("\u{1B}");
  });

  it.each(["42", '["only"]', '["pkg",42]', '{"label":"x"}', "custom:task"])(
    "keeps literal task names: %s",
    (name) => {
      // Arrange
      const model = new ProgressModel(graphFor(task(name, [], false)), name);
      // Act & Assert
      expect(model.frame(0, { limit: 20 })).toContain(name);
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
    const frame = model.frame(0, { limit: 3 });
    // Assert
    expect(frame).toContain("root (");
    expect(frame).toContain("  | group (");
    expect(frame).toContain("    | active");
    expect(frame).toContain("2 more tasks");
    expect(frame.split("\n")).toHaveLength(4);
    expect(model.frame(0, { limit: 1 }).split("\n").length).toBeLessThanOrEqual(
      2,
    );
  });

  it("keeps dependencies visible when their workspace validation group is not selected", () => {
    // Arrange
    const target = "validate:web";
    const graph = graphFor(
      task(target, ["apps/web#build"], false),
      task(
        "apps/web#build",
        [
          "packages/lib#build",
          "apps/web#clean",
          "apps/web#compile",
          "apps/web#resolve-paths",
        ],
        false,
        "apps/web",
      ),
      task(
        "packages/lib#build",
        [
          "packages/lib#clean",
          "packages/lib#compile",
          "packages/lib#resolve-paths",
        ],
        false,
        "packages/lib",
      ),
      task("apps/web#clean", ["packages/lib#build"], true, "apps/web"),
      task("apps/web#compile", ["apps/web#clean"], true, "apps/web"),
      task("apps/web#resolve-paths", ["apps/web#compile"], true, "apps/web"),
      task("packages/lib#clean", [], true, "packages/lib"),
      task(
        "packages/lib#compile",
        ["packages/lib#clean"],
        true,
        "packages/lib",
      ),
      task(
        "packages/lib#resolve-paths",
        ["packages/lib#compile"],
        true,
        "packages/lib",
      ),
    );
    const frame = new ProgressModel(graph, "validate:web", false).frame(0);
    // Assert
    expect(frame).toContain("    . lib:build");
    expect(frame).toContain("      . clean");
    expect(frame.match(/\. clean/g)).toHaveLength(2);
  });

  it("places shared builds under their own validation groups regardless of first consumer", () => {
    // Arrange
    const target = "validate";
    const graph = graphFor(...sharedBuildTasks());
    const model = new ProgressModel(graph, target, false);
    const frame = model.frame(0);
    for (const item of graph.values())
      model.update({
        package: item.package,
        status: "blocked",
        taskId: item.id,
      });
    const failed = model.frame(0);
    // Assert
    expect(frame).not.toContain(" > ");
    expect(frame.match(/^ {4}\. build$/gm)).toHaveLength(3);
    expect(frame.indexOf("validate:contract")).toBeLessThan(
      frame.lastIndexOf(". clean"),
    );
    expect(frame).not.toMatch(/^ {2}\. build /m);
    expect(frame.match(/\. clean/g)).toHaveLength(3);
    expect(failed.match(/! clean/g)).toHaveLength(3);
    expect(
      model.eventLine({ package: ".", status: "blocked", taskId: id("build") }),
    ).toBeUndefined();
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
    const frame = model.frame(0);
    const limited = model.frame(0, { limit: 7 });
    // Assert
    expect(frame.split("\n")).toHaveLength(101);
    expect(frame).toContain("... 11 more tasks");
    expect(limited.split("\n")).toHaveLength(8);
    expect(limited).toContain("... 104 more tasks");
  });

  it("reports invalid presentation plans and unknown task events explicitly", () => {
    const model = new ProgressModel(graphFor(task("root")), "root");
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
