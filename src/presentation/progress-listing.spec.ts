import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { make } from "ts-brand";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompiledTask, TaskId } from "../domain";

import { TerminalProgress } from "./progress";

const id = make<TaskId>()("check");
const graph = new Map<TaskId, CompiledTask>([
  [
    id,
    {
      dependsOn: [],
      id,
      package: ".",
      run: { kind: "npm", script: "check" },
      skip: false,
    },
  ],
]);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("terminal progress", () => {
  it.each([0, -1, 1.5, NaN, Infinity])(
    "rejects invalid task limit %s",
    (limit) => {
      // Arrange & Act & Assert
      expect(
        () => new TerminalProgress(new PassThrough(), true, false, limit),
      ).toThrow("Max tasks must be a positive integer");
    },
  );

  it.each(["failed", "blocked", "cancelled"] as const)(
    "persists completed children beyond a tiny viewport after %s without collapsing",
    (status) => {
      // Arrange
      vi.useFakeTimers();
      const taskId = make<TaskId>();
      const root = taskId("validate");
      const build = taskId("build");
      const clean = taskId("clean");
      const compile = taskId("compile");
      const test = taskId("test");
      const tasks = new Map<TaskId, CompiledTask>([
        [
          build,
          { dependsOn: [clean, compile], id: build, package: ".", skip: false },
        ],
        [
          root,
          { dependsOn: [build, test], id: root, package: ".", skip: false },
        ],
        ...[clean, compile, test].map((task): [TaskId, CompiledTask] => [
          task,
          {
            dependsOn: [],
            id: task,
            package: ".",
            run: { kind: "npm", script: task },
            skip: false,
          },
        ]),
      ]);
      const output = Object.assign(new PassThrough(), { columns: 80, rows: 1 });
      let text = "";
      output.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      const progress = new TerminalProgress(output, true, false);
      // Act
      progress.start(tasks, root);
      for (const task of [clean, compile, build])
        progress.update({
          durationMs: 100,
          package: ".",
          status: "succeeded",
          taskId: task,
        });
      progress.update({ package: ".", status, taskId: test });
      progress.update({ package: ".", status: "blocked", taskId: root });
      const offset = text.length;
      progress.stop();
      const final = stripVTControlCharacters(text.slice(offset));
      // Assert
      expect(final).toContain("validate (blocked");
      expect(final).toContain("  \u{2714} build (succeeded, 0.1s)");
      expect(final).toContain("    \u{2714} clean (succeeded, 0.1s)");
      expect(final).toContain("    \u{2714} compile (succeeded, 0.1s)");
      expect(final).toContain(`test (${status})`);
      expect(final).not.toContain("more tasks");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([undefined, 3])(
    "limits the final listing to %s task rows independently of terminal height",
    (limit) => {
      // Arrange
      const taskId = make<TaskId>();
      const root = taskId("root");
      const children = Array.from({ length: 105 }, (_, index) =>
        taskId(`child-${String(index)}`),
      );
      const tasks = new Map<TaskId, CompiledTask>([
        [root, { dependsOn: children, id: root, package: ".", skip: false }],
        ...children.map((child): [TaskId, CompiledTask] => [
          child,
          {
            dependsOn: [],
            id: child,
            package: ".",
            run: { kind: "npm", script: child },
            skip: false,
          },
        ]),
      ]);
      const output = Object.assign(new PassThrough(), { columns: 80, rows: 3 });
      let text = "";
      output.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      const progress = new TerminalProgress(output, true, false, limit);
      // Act
      progress.start(tasks, root);
      const offset = text.length;
      progress.stop();
      const final = stripVTControlCharacters(text.slice(offset)).trim();
      // Assert
      expect(final.split("\n")).toHaveLength((limit ?? 100) + 1);
      expect(final).toContain(`... ${String(106 - (limit ?? 100))} more tasks`);
    },
  );

  it.each([
    { colored: true, forceColor: undefined, noColor: undefined },
    { colored: false, forceColor: undefined, noColor: "" },
    { colored: false, forceColor: "1", noColor: "1" },
    { colored: false, forceColor: "0", noColor: undefined },
    { colored: true, forceColor: "1", noColor: undefined },
  ])(
    "respects color preferences: $noColor / $forceColor",
    ({ colored, forceColor, noColor }) => {
      // Arrange
      vi.stubEnv("NO_COLOR", noColor);
      vi.stubEnv("FORCE_COLOR", forceColor);
      const output = new PassThrough();
      let text = "";
      output.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      const progress = new TerminalProgress(output, true);
      // Act
      try {
        progress.start(graph, id);
        progress.update({ package: ".", status: "succeeded", taskId: id });
      } finally {
        progress.stop();
      }
      // Assert
      expect(text.includes("\u{1B}[32m")).toBe(colored);
      expect(stripVTControlCharacters(text)).toContain(
        "\u{2714} check (succeeded)",
      );
    },
  );
  it.each([undefined, 12])(
    "redraws live output at terminal height %s and releases the animation on stop",
    (rows) => {
      // Arrange
      vi.useFakeTimers();
      const output = Object.assign(new PassThrough(), {
        ...(rows !== undefined && { rows }),
        columns: 80,
      });
      let text = "";
      output.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      const progress = new TerminalProgress(output, true);
      // Act
      progress.start(graph, id);
      progress.update({ package: ".", status: "running", taskId: id });
      vi.advanceTimersByTime(160);
      progress.update({
        durationMs: 160,
        package: ".",
        status: "succeeded",
        taskId: id,
      });
      progress.stop();
      const settled = text;
      progress.stop();
      vi.advanceTimersByTime(1000);
      // Assert
      expect(stripVTControlCharacters(text)).toContain("check (pending)");
      expect(stripVTControlCharacters(text)).toContain("check (running");
      expect(stripVTControlCharacters(text)).toContain(
        "check (succeeded, 0.2s)",
      );
      expect(text).toContain("\u{1B}[");
      expect(text).toBe(settled);
      expect(vi.getTimerCount()).toBe(0);
      expect(text).not.toContain("\u{1B}[?25l");
    },
  );

  it("prints concise plain output without ready transitions, escape codes, or timers", () => {
    // Arrange
    vi.useFakeTimers();
    vi.stubEnv("FORCE_COLOR", "1");
    const output = new PassThrough();
    const write = vi.spyOn(output, "write");
    const progress = new TerminalProgress(output, false);
    // Act
    progress.start(graph, id);
    progress.update({ package: ".", status: "ready", taskId: id });
    progress.update({ package: ".", status: "running", taskId: id });
    progress.update({
      durationMs: 100,
      package: ".",
      status: "failed",
      taskId: id,
    });
    progress.stop();
    // Assert
    expect(write.mock.calls).toEqual([
      ["| check (running, 0.0s)\n"],
      ["x check (failed, 0.1s)\n"],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects invalid lifecycle calls and can stop before starting", () => {
    // Arrange
    const progress = new TerminalProgress(new PassThrough(), false);
    // Act & Assert
    progress.stop();
    expect(() => progress.summary()).toThrow("has not started");
    expect(() => {
      progress.update({ package: ".", status: "running", taskId: id });
    }).toThrow("has not started");
    progress.start(graph, id);
    expect(progress.summary()).toBe("Tasks: 1 | pending: 1");
    expect(() => {
      progress.start(graph, id);
    }).toThrow("already started");
  });
});
