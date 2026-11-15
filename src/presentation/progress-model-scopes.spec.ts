import { make } from "ts-brand";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompiledTask, TaskEvent, TaskId, TaskStatus } from "../domain";

import { workspacePhaseTasks } from "./__tests__";
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
  it("counts only unique command tasks independently of collapse and frame limits", () => {
    // Arrange
    const states: TaskStatus[] = [
      "pending",
      "ready",
      "running",
      "succeeded",
      "failed",
      "blocked",
      "cancelled",
    ];
    const model = new ProgressModel(
      graphFor(
        task("root", ["group", ...states], false),
        task("group", ["child"], false),
        task("child"),
        ...states.map((name) => task(name)),
      ),
      "root",
    );
    // Act
    expect(model.summary()).toBe("Tasks: 8 | pending: 8");
    for (const state of states) model.update(event(state, state));
    model.update(event("child", "succeeded"));
    model.update(event("group", "succeeded"));
    const limited = model.frame(0, { limit: 2 });
    // Assert
    expect(limited).not.toContain("child");
    expect(model.summary()).toBe(
      "Tasks: 8 | pending: 1 | ready: 1 | running: 1 | succeeded: 2 | failed: 1 | blocked: 1 | cancelled: 1",
    );
    // Act
    model.update(event("running", "succeeded"));
    model.update(event("root", "blocked"));
    // Assert
    expect(model.summary()).toBe(
      "Tasks: 8 | pending: 1 | ready: 1 | succeeded: 3 | failed: 1 | blocked: 1 | cancelled: 1",
    );
  });

  it("labels a workspace mutation task as automation:mutation", () => {
    // Arrange
    const target = "mutation";
    const command: CompiledTask = {
      dependsOn: [],
      id: id("apps/automation#mutation"),
      package: "apps/automation",
      run: { kind: "npm", script: "mutation" },
    };
    const model = new ProgressModel(
      graphFor(task(target, ["apps/automation#mutation"], false), command),
      target,
      false,
      [".", "apps/automation"],
    );
    // Act
    const frame = model.frame(0);
    // Assert
    expect(frame).toContain("automation:mutation");
  });

  it("uses short package labels when a validation group spans multiple workspaces", () => {
    // Arrange
    const group = "validate:automation";
    const model = new ProgressModel(
      graphFor(
        task(group, ["one", "two"], false),
        task("one", [], true, "apps/automation"),
        task("two", [], true, "packages/lib"),
      ),
      group,
      false,
    );
    // Act
    const frame = model.frame(0, { limit: 20 });
    // Assert
    expect(frame).toContain("automation:one");
    expect(frame).toContain("lib:two");
  });
  it("uses a full package path when configured suffixes collide", () => {
    // Arrange
    const target = "mutation";
    const command = {
      ...task("automation-mutation", [], true, "apps/automation"),
      run: { kind: "npm", script: "mutation" } as const,
    };
    const model = new ProgressModel(
      graphFor(task(target, ["automation-mutation"], false), command),
      target,
      false,
      [".", "apps/automation", "packages/automation"],
    );
    // Act
    const frame = model.frame(0);
    // Assert
    expect(frame).toContain("apps/automation:mutation");
  });
  it("does not reserve dependencies for a command that resembles a validation group", () => {
    // Arrange
    const target = "validate:web";
    const model = new ProgressModel(
      graphFor(
        task(target, ["compile"]),
        task("compile", [], true, "apps/web"),
      ),
      target,
      false,
    );
    // Act
    const frame = model.frame(0);
    model.update(event("compile", "succeeded", 100));
    // Assert
    expect(frame).toContain(". web:compile");
    expect(model.eventLine(event("compile", "succeeded"))).toContain("compile");
  });
  it("shows monorepo validation grouped by workspace with readable nested checks", () => {
    // Arrange
    const target = "validate";
    const graph = graphFor(
      task(target, ["lint", "validate:lib", "validate:web", "docs"], false),
      task("lint", ["prettier", "eslint"], false),
      task("prettier"),
      task("eslint"),
      task("docs"),
      task(
        "validate:lib",
        ["packages/lib#build", "packages/lib#test:all"],
        false,
      ),
      task("validate:web", ["apps/web#build", "apps/web#test:all"], false),
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
        "packages/lib#test:all",
        ["packages/lib#test"],
        false,
        "packages/lib",
      ),
      task("apps/web#test:all", ["apps/web#test"], false, "apps/web"),
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
      task("packages/lib#test", [], true, "packages/lib"),
      task("apps/web#clean", ["packages/lib#build"], true, "apps/web"),
      task("apps/web#compile", ["apps/web#clean"], true, "apps/web"),
      task("apps/web#resolve-paths", ["apps/web#compile"], true, "apps/web"),
      task("apps/web#test", [], true, "apps/web"),
    );
    // Act
    const frame = new ProgressModel(graph, target, false).frame(0, {
      limit: 200,
    });
    // Assert
    expect(frame.split("\n").filter((line) => /^ {2}\S/.test(line))).toEqual([
      "  . lint",
      "  . validate:lib",
      "  . validate:web",
      "  . docs",
    ]);
    expect(frame).toContain("    . test:all");
    expect(frame).not.toContain("web:");
    expect(frame).not.toContain("validation:[");
    expect(frame.match(/\. clean/g)).toHaveLength(2);
    expect(frame).not.toContain("apps/web:");
    expect(frame).not.toContain("packages/lib:");
  });
  it.each([true, false])(
    "collapses completed subtasks only when enabled: %s",
    (collapse) => {
      // Arrange
      const model = new ProgressModel(
        graphFor(task("root", ["child"], false), task("child")),
        "root",
        collapse,
      );
      // Act
      vi.useFakeTimers();
      model.update(event("child", "running"));
      vi.advanceTimersByTime(100);
      model.update(event("child", "succeeded", 100));
      model.update(event("root", "succeeded", 100));
      // Assert
      expect(model.frame(0, { limit: 20 })).toBe(
        "+ root (⧗ 0.1s, ∑ 0.1s)" + (collapse ? "" : "\n  + child (0.1s)"),
      );
    },
  );
  it("keeps other workspaces and later phases pending while a shared build runs", () => {
    // Arrange
    vi.useFakeTimers();
    const target = "validate";
    const graph = graphFor(...workspacePhaseTasks());
    const model = new ProgressModel(graph, target, false);
    // Act
    model.update(event("packages/lib#clean", "running"));
    vi.advanceTimersByTime(1300);
    const sharedBuild = model.frame(0, { limit: 1000 });
    model.update(event("packages/lib#clean", "succeeded", 1300));
    model.update(event("apps/web#clean", "running"));
    vi.advanceTimersByTime(200);
    const webBuild = model.frame(0, { limit: 1000 });
    // Assert
    expect(sharedBuild).toContain("| validate (⧗ 1.3s, ∑ 1.3s)");
    expect(sharedBuild).toContain("| validate:lib (⧗ 1.3s, ∑ 1.3s)");
    expect(sharedBuild).toContain(". validate:web");
    expect(sharedBuild).toContain(". validate:back");
    expect(sharedBuild).not.toMatch(/(?:pack|test:all) \(/);
    expect(webBuild).toContain("| validate:web (⧗ 0.2s, ∑ 0.2s)");
    expect(webBuild).toContain(". validate:back");
    expect(webBuild).not.toMatch(/(?:pack|test:all) \(/);
    expect(model.summary()).toContain("running: 1");
  });
});
