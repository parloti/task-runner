import { stripVTControlCharacters } from "node:util";
import { make } from "ts-brand";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CompiledTask,
  TaskEvent,
  TaskId,
  TaskStatus,
} from "../domain/types.js";
import { ProgressModel } from "./progress-model.js";
import { compileGraph } from "../domain/graph.js";
import { createWorkspacePreset } from "../presets/index.js";
import { executeGraph } from "../application/execute.js";

const id = make<TaskId>();
const task = (
  name: string,
  dependencies: string[] = [],
  command = true,
  packagePath = ".",
): CompiledTask => ({
  id: id(name),
  package: packagePath,
  dependsOn: dependencies.map(id),
  skip: false,
  ...(command ? { run: { kind: "npm", script: name } as const } : {}),
});
const graphFor = (...tasks: CompiledTask[]) =>
  new Map(tasks.map((item) => [item.id, item]));
const event = (
  name: string,
  status: TaskStatus,
  durationMs?: number,
): TaskEvent => ({
  taskId: id(name),
  package: ".",
  status,
  ...(durationMs === undefined ? {} : { durationMs }),
});

afterEach(() => vi.useRealTimers());

describe("nested progress model", () => {
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
      expect(active).toContain("nested (running,");
      expect(active).toContain("command (running,");
      expect(active).toContain("later (pending)");
      expect(active.includes("queued")).toBe(collapse === false);
      expect(completed).toContain("first (succeeded,");
      expect(completed.includes("nested")).toBe(collapse === false);
      expect(model.summary()).toBe("Tasks: 2 | pending: 1 | succeeded: 1");
    },
  );
  it("counts only unique command tasks independently of collapse and frame limits", () => {
    // Arrange
    const states: TaskStatus[] = [
      "pending",
      "ready",
      "running",
      "succeeded",
      "failed",
      "skipped",
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
    expect(model.summary()).toBe("Tasks: 9 | pending: 9");
    for (const state of states) model.update(event(state, state));
    model.update(event("child", "succeeded"));
    model.update(event("group", "succeeded"));
    const limited = model.frame(0, 2);
    // Assert
    expect(limited).not.toContain("child");
    expect(model.summary()).toBe(
      "Tasks: 9 | pending: 1 | ready: 1 | running: 1 | succeeded: 2 | failed: 1 | skipped: 1 | blocked: 1 | cancelled: 1",
    );
    // Act
    model.update(event("running", "succeeded"));
    model.update(event("root", "blocked"));
    // Assert
    expect(model.summary()).toBe(
      "Tasks: 9 | pending: 1 | ready: 1 | succeeded: 3 | failed: 1 | skipped: 1 | blocked: 1 | cancelled: 1",
    );
  });

  it("counts shared commands once and excludes omitted aggregate wrappers", () => {
    // Arrange
    const preset = createWorkspacePreset([
      { path: ".", name: "root" },
      { path: "packages/lib", name: "lib", utility: true },
      { path: "apps/web", name: "web", internalDependencies: ["lib"] },
    ]);
    const target = "validate";
    const graph = compileGraph(
      preset.config,
      target,
      new Map(Object.entries(preset.scripts)),
    );
    const model = new ProgressModel(graph, target, false);
    const commandCount = [...graph.values()].filter(
      (task) => task.run !== undefined,
    ).length;
    // Act
    const initial = model.summary();
    for (const task of graph.values())
      model.update({
        taskId: task.id,
        package: task.package,
        status: "succeeded",
      });
    // Assert
    expect(commandCount).toBeLessThan(graph.size);
    expect(initial).toBe(`Tasks: ${commandCount} | pending: ${commandCount}`);
    expect(model.summary()).toBe(
      `Tasks: ${commandCount} | succeeded: ${commandCount}`,
    );
    expect(model.frame(0, 1000)).not.toMatch(/^ {2}\+ build /m);
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

  it.each([1, 4])(
    "keeps command counts and global concurrency aligned across nested groups at limit %i",
    async (concurrency) => {
      // Arrange
      const branches = Array.from(
        { length: 8 },
        (_, index) => `branch-${index}`,
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
              [...states].filter(
                ([id, status]) =>
                  graph.get(id)!.run !== undefined && status === "running",
              ).length,
            );
            reportedRunning.push(
              Number(/running: (\d+)/.exec(model.summary())?.[1] ?? 0),
            );
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
    const frame = model.frame(0, 50);
    const direct = new ProgressModel(tasks, contract, false).frame(0, 50);
    model.update(event("clean", "running", 13600));
    // Assert
    expect(frame).toBe(
      [
        ". validate:automation (pending)",
        "  . build (pending)",
        "    . packages/api-contract > build (pending)",
        "      . packages/utils > build (pending)",
        "        . utility-compile (pending)",
        "      . clean (pending)",
        "      . compile (pending)",
        "      . resolve-paths (pending)",
        "    . app-compile (pending)",
      ].join("\n"),
    );
    expect(direct).toContain(". packages/api-contract > build (pending)");
    expect(direct).toContain("  . clean (pending)");
    expect(model.eventLine(event("clean", "running"))).toBe(
      "      | clean (running, 13.6s)",
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
    model.update(event(tests, "blocked", 107200));
    const frame = model.frame(0, 30);
    // Assert
    expect(frame).toContain("validate:automation (pending)");
    expect(frame).toContain("  ! test:all (blocked, 107.2s)");
    expect(frame).toContain("    . test (pending)");
    expect(frame).toContain("    . packages/lib > shared (pending)");
    expect(model.eventLine(event(tests, "blocked"))).toBe(
      "  ! test:all (blocked, 107.2s)",
    );
  });

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
      { path: ".", name: "root", styles: true },
      { path: "packages/lib", name: "lib", utility: true },
      { path: "apps/web", name: "web", internalDependencies: ["lib"] },
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
    vi.advanceTimersByTime(10000);
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
      { path: ".", name: "root" },
      { path: "apps/web", name: "web", internalDependencies: ["lib"] },
      { path: "apps/back", name: "back", internalDependencies: ["lib"] },
      { path: "packages/lib", name: "lib", utility: true },
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
    ["pending", "\u25a1", 90],
    ["ready", "\u203a", 33],
    ["running", "\u280b", 36],
    ["succeeded", "\u2714", 32],
    ["failed", "\u2716", 31],
    ["skipped", "\u2193", 90],
    ["blocked", "\u26a0", 33],
    ["cancelled", "\u25a0", 35],
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
      expect(colored).toContain(`\u001b[${color}m${icon}\u001b[39m`);
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
    expect(frames[0]).toContain("\u001b[36m\u280b\u001b[39m root");
    expect(frames[1]).toContain("  \u001b[36m\u2819\u001b[39m active");
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
        ...task("shell\u001b[2J\nname", [], false, "pkg\u0007"),
        run: { kind: "shell", command: "echo ok" },
      }),
      "shell\u001b[2J\nname",
    );
    // Act
    const frame = model.frame(0, 20);
    // Assert
    expect(frame).toBe(". pkg  > shell name (pending)");
    expect(frame).not.toContain("\u001b");
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
      { path: ".", name: "root" },
      {
        path: "apps/automation",
        name: "automation",
        internalDependencies: ["contract"],
      },
      { path: "apps/back", name: "back", internalDependencies: ["contract"] },
      { path: "packages/contract", name: "contract", utility: true },
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
        taskId: task.id,
        package: task.package,
        status: "blocked",
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
      model.eventLine({ taskId: id("build"), package: ".", status: "blocked" }),
    ).toBeUndefined();
  });

  it("keeps dependencies visible when their workspace validation group is not selected", () => {
    // Arrange
    const preset = createWorkspacePreset([
      { path: ".", name: "root" },
      { path: "apps/web", name: "web", internalDependencies: ["lib"] },
      { path: "packages/lib", name: "lib", utility: true },
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
    const names = Array.from({ length: 110 }, (_, index) => `task-${index}`);
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
    expect(() => model.update(event("missing", "running"))).toThrow(
      "Unknown progress task",
    );
    expect(() => model.eventLine(event("missing", "failed"))).toThrow(
      "Unknown progress task",
    );
  });
});
