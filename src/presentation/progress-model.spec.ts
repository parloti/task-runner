import { make } from "ts-brand";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompiledTask, TaskEvent, TaskId, TaskStatus } from "../domain";

import { executeGraph } from "../application";
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
  it("shows a remembered failed task outside the requested tree", () => {
    // Arrange
    const model = new ProgressModel(
      graphFor(task("requested"), task("remembered")),
      "requested",
      false,
    );

    // Act
    model.update(event("remembered", "failed"));

    // Assert
    expect(model.summary()).toBe("Tasks: 2 | pending: 1 | failed: 1");
    expect(model.frame(0)).toContain("x remembered");
  });

  it("shows cached successes separately and preserves the previous completion time", () => {
    // Arrange
    const model = new ProgressModel(
      graphFor(task("validate", ["test"], false), task("test")),
      "validate",
      false,
    );
    const completedAt = "2026-11-15T17:00:00.000Z";
    // Act
    model.update({ ...event("test", "cached"), completedAt, durationMs: 0 });
    model.update({
      ...event("validate", "cached"),
      completedAt,
      durationMs: 0,
    });
    // Assert
    expect(model.summary()).toBe("Tasks: 1 | cached: 1");
    expect(model.frame(0)).toContain(`last success: ${completedAt}`);
  });
  it.each([undefined, true, false])(
    "keeps unstarted nested groups collapsed with collapse=%s",
    (collapse) => {
      // Arrange
      const model = new ProgressModel(
        graphFor(
          task("root", ["first", "later"], false),
          task("first", ["nested"], false),
          task("nested", ["command"], false),
          task("command"),
          task("later", ["queued"], false),
          task("queued"),
        ),
        "root",
        collapse,
      );
      // Act
      const initial = model.frame(0);
      model.update(event("command", "running"));
      const active = model.frame(0);
      model.update(event("command", "succeeded"));
      model.update(event("nested", "succeeded"));
      model.update(event("first", "succeeded"));
      const completed = model.frame(0);
      // Assert
      expect(initial.includes("first")).toBe(collapse === false);
      expect(active).toContain("nested (");
      expect(active).toContain("command (");
      expect(active).toContain("later");
      expect(active.includes("queued")).toBe(collapse === false);
      expect(completed).toContain("first (");
      expect(completed.includes("nested")).toBe(collapse === false);
      expect(model.summary()).toBe("Tasks: 2 | pending: 1 | succeeded: 1");
    },
  );
  it("counts shared commands once and excludes omitted aggregate wrappers", () => {
    // Arrange
    const target = "validate";
    const graph = graphFor(
      task(target, ["validate:lib", "validate:web"], false),
      task("validate:lib", ["packages/lib#build"], false),
      task("validate:web", ["apps/web#build"], false),
      task(
        "packages/lib#build",
        ["packages/lib#compile"],
        false,
        "packages/lib",
      ),
      task(
        "apps/web#build",
        ["packages/lib#build", "apps/web#compile"],
        false,
        "apps/web",
      ),
      task("packages/lib#compile", [], true, "packages/lib"),
      task("apps/web#compile", [], true, "apps/web"),
    );
    const model = new ProgressModel(graph, target, false);
    const commandCount = graph
      .values()
      .filter((task) => task.run !== undefined)
      .toArray().length;
    // Act
    const initial = model.summary();
    for (const task of graph.values())
      model.update({
        package: task.package,
        status: "succeeded",
        taskId: task.id,
      });
    // Assert
    expect(commandCount).toBeLessThan(graph.size);
    expect(initial).toBe(
      `Tasks: ${String(commandCount)} | pending: ${String(commandCount)}`,
    );
    expect(model.summary()).toBe(
      `Tasks: ${String(commandCount)} | succeeded: ${String(commandCount)}`,
    );
    expect(model.frame(0, { limit: 1000 })).not.toMatch(/^ {2}\+ build /m);
  });

  it.each([1, 4])(
    "keeps command counts and global concurrency aligned across nested groups at limit %i",
    async (concurrency) => {
      // Arrange
      const branches = Array.from(
        { length: 8 },
        (_, index) => `branch-${String(index)}`,
      );
      const graph = graphFor(
        task("root", branches, false),
        ...branches.flatMap((branch) => [
          task(branch, [`${branch}-group`], false, branch),
          task(`${branch}-group`, [`${branch}-command`], false, branch),
          task(`${branch}-command`, ["shared"], true, branch),
        ]),
        task("shared", ["prepare"]),
        task("prepare"),
      );
      const model = new ProgressModel(graph, "root");
      const states = new Map<TaskId, TaskStatus>();
      const snapshots: string[] = [];
      const reportedRunning: number[] = [];
      const expectedRunning: number[] = [];
      let active = 0;
      let peak = 0;
      // Act
      const result = await executeGraph(
        graph,
        async () => {
          peak = Math.max(peak, ++active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active--;
        },
        {
          concurrency,
          onEvent: (event) => {
            states.set(event.taskId, event.status);
            model.update(event);
            snapshots.push(model.summary());
            expectedRunning.push(
              states
                .entries()
                .filter(
                  ([id, status]) =>
                    graph.get(id)?.run !== undefined && status === "running",
                )
                .toArray().length,
            );
            const runningValue =
              /running: (\d+)/.exec(model.summary())?.[1] ?? "0";
            reportedRunning.push(Number(runningValue));
          },
        },
      );
      // Assert
      expect(result.success).toBe(true);
      expect(peak).toBe(concurrency);
      expect(reportedRunning).toEqual(expectedRunning);
      expect(Math.max(...reportedRunning)).toBe(concurrency);
      expect(
        snapshots.every((summary) => summary.startsWith("Tasks: 10 |")),
      ).toBe(true);
      expect(model.summary()).toBe("Tasks: 10 | succeeded: 10");
    },
  );
  it("changes package scope at each nested group without leaking it to siblings", () => {
    // Arrange
    const group = "validate:automation";
    const build = "apps/automation#build";
    const contract = "packages/api-contract#build";
    const utility = "packages/utils#build";
    const tasks = graphFor(
      task(group, [build], false),
      task(build, [contract, "app-compile"], false, "apps/automation"),
      task(
        contract,
        [utility, "clean", "compile", "resolve-paths"],
        false,
        "packages/api-contract",
      ),
      task(utility, ["utility-compile"], false, "packages/utils"),
      task("utility-compile", [], true, "packages/utils"),
      task("clean", [], true, "packages/api-contract"),
      task("compile", [], true, "packages/api-contract"),
      task("resolve-paths", [], true, "packages/api-contract"),
      task("app-compile", [], true, "apps/automation"),
    );
    const model = new ProgressModel(tasks, group, false);
    // Act
    const frame = model.frame(0, { limit: 50 });
    const direct = new ProgressModel(tasks, contract, false).frame(0, {
      limit: 50,
    });
    model.update(event("clean", "running", 13_600));
    // Assert
    expect(frame).toBe(
      [
        ". validate:automation",
        "  . build",
        "    . api-contract:build",
        "      . utils:build",
        "        . utility-compile",
        "      . clean",
        "      . compile",
        "      . resolve-paths",
        "    . app-compile",
      ].join("\n"),
    );
    expect(direct).toContain(". api-contract:build");
    expect(direct).toContain("  . clean");
    expect(model.eventLine(event("clean", "running"))).toBe(
      "      | clean (13.6s)",
    );
  });
  it("omits redundant scope through nested groups but retains cross-workspace labels", () => {
    // Arrange
    const group = "validate:automation";
    const tests = "apps/automation#test:all";
    const model = new ProgressModel(
      graphFor(
        task(group, [tests], false),
        task(tests, ["test"], false, "apps/automation"),
        task("test", ["shared"], true, "apps/automation"),
        task("shared", [], true, "packages/lib"),
      ),
      group,
      false,
    );
    // Act
    model.update(event(tests, "blocked", 107_200));
    const frame = model.frame(0, { limit: 30 });
    // Assert
    expect(frame).toContain("validate:automation");
    expect(frame).toContain("  ! test:all (⧗ 0.0s, ∑ 0.0s)");
    expect(frame).toContain("    . test");
    expect(frame).toContain("    . lib:shared");
    expect(model.eventLine(event(tests, "blocked"))).toBe(
      "  ! test:all (⧗ 0.0s, ∑ 0.0s)",
    );
  });
});
