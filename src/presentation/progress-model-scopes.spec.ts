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
  it("keeps package prefixes when a validation-named group spans multiple workspaces", () => {
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
    const frame = model.frame(0, 20);
    // Assert
    expect(frame).toContain("apps/automation > one");
    expect(frame).toContain("packages/lib > two");
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
    expect(frame).toContain(". apps/web > compile (pending)");
    expect(model.eventLine(event("compile", "succeeded"))).toContain(
      "compile (succeeded",
    );
  });
  it("shows monorepo validation grouped by workspace with readable nested checks", () => {
    // Arrange
    const preset = createWorkspacePreset([
      { name: "root", path: ".", styles: true },
      { name: "lib", path: "packages/lib", utility: true },
      { internalDependencies: ["lib"], name: "web", path: "apps/web" },
    ]);
    const target = "validate";
    const graph = compileGraph(
      preset.config,
      target,
      new Map(Object.entries(preset.scripts)),
    );
    // Act
    const frame = new ProgressModel(graph, target, false).frame(0, 200);
    // Assert
    expect(frame.split("\n").filter((line) => /^ {2}\S/.test(line))).toEqual([
      "  . lint (pending)",
      "  . validate:lib (pending)",
      "  . validate:web (pending)",
      "  . docs (pending)",
    ]);
    expect(frame).toContain("    . test:all (pending)");
    expect(frame).not.toContain("validation:[");
    expect(frame.match(/clean \(pending\)/g)).toHaveLength(2);
    expect(frame).not.toContain("apps/web >");
    expect(frame).not.toContain("packages/lib >");
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
      model.update(event("child", "succeeded", 100));
      model.update(event("root", "succeeded", 100));
      // Assert
      expect(model.frame(0, 20)).toBe(
        "+ root (succeeded, 0.1s)" +
          (collapse ? "" : "\n  + child (succeeded, 0.1s)"),
      );
    },
  );
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
    const live = model.frame(0, 30);
    vi.advanceTimersByTime(800);
    model.update(event("compile", "succeeded", 800));
    model.update(event("build", "succeeded"));
    vi.advanceTimersByTime(500);
    model.update(event("artifact", "running"));
    vi.advanceTimersByTime(1000);
    model.update(event("artifact", "succeeded", 1000));
    model.update(event("pack", "succeeded"));
    const completedGroups = model.frame(0, 30);
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
    expect(model.frame(0, 30)).toBe("+ validate (succeeded, 4.5s)");
    expect(model.eventLine(event("pack", "succeeded"))).toBe(
      "  + pack (succeeded, 1.0s)",
    );
  });

  it("keeps other workspaces and later phases pending while a shared build runs", () => {
    // Arrange
    vi.useFakeTimers();
    const preset = createWorkspacePreset([
      { name: "root", path: "." },
      { internalDependencies: ["lib"], name: "web", path: "apps/web" },
      { internalDependencies: ["lib"], name: "back", path: "apps/back" },
      { name: "lib", path: "packages/lib", utility: true },
    ]);
    const target = "validate";
    const graph = compileGraph(
      preset.config,
      target,
      new Map(Object.entries(preset.scripts)),
    );
    const model = new ProgressModel(graph, target, false);
    // Act
    model.update(event("packages/lib#clean", "running"));
    vi.advanceTimersByTime(1300);
    const sharedBuild = model.frame(0, 1000);
    model.update(event("packages/lib#clean", "succeeded", 1300));
    model.update(event("apps/web#clean", "running"));
    vi.advanceTimersByTime(200);
    const webBuild = model.frame(0, 1000);
    // Assert
    expect(sharedBuild).toContain("| validate (running, 1.3s)");
    expect(sharedBuild).toContain("| validate:lib (running, 1.3s)");
    expect(sharedBuild).toContain(". validate:web (pending)");
    expect(sharedBuild).toContain(". validate:back (pending)");
    expect(sharedBuild).not.toMatch(/(?:pack|test:all) \(running/);
    expect(webBuild).toContain("| validate:web (running, 0.2s)");
    expect(webBuild).toContain(". validate:back (pending)");
    expect(webBuild).not.toMatch(/(?:pack|test:all) \(running/);
    expect(model.summary()).toContain("running: 1");
  });
});
