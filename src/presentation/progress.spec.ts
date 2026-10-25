import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { make } from "ts-brand";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompiledTask, TaskId } from "../domain/types.js";
import { TerminalProgress } from "./progress.js";

const id = make<TaskId>()("check");
const graph = new Map<TaskId, CompiledTask>([
  [
    id,
    {
      id,
      package: ".",
      dependsOn: [],
      skip: false,
      run: { kind: "npm", script: "check" },
    },
  ],
]);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("terminal progress", () => {
  it.each([
    { scroll: false, status: "succeeded" },
    { scroll: false, status: "failed" },
    { scroll: false, status: "cancelled" },
    { scroll: true, status: "succeeded" },
    { scroll: true, status: "failed" },
    { scroll: true, status: "cancelled" },
  ] as const)(
    "preserves blank separators around the final $status tree with scroll=$scroll",
    ({ scroll, status }) => {
      // Arrange
      const output = Object.assign(new PassThrough(), { rows: 1, columns: 80 });
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: vi.fn(),
      });
      const write = vi.spyOn(output, "write");
      const progress = new TerminalProgress(
        output,
        true,
        false,
        100,
        scroll ? { input, onInterrupt: vi.fn() } : undefined,
      );
      progress.start(graph, id);
      progress.update({ taskId: id, package: ".", status });
      const offset = write.mock.calls.length;
      // Act
      progress.stop();
      const final = stripVTControlCharacters(
        write.mock.calls
          .slice(offset)
          .map(([text]) => String(text))
          .join(""),
      );
      // Assert
      expect(final).toMatch(
        new RegExp(`^\\n[^\\n]+ check \\(${status}\\)\\n\\n$`),
      );
      const calls = write.mock.calls.length;
      progress.stop();
      expect(write).toHaveBeenCalledTimes(calls);
    },
  );

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "restores a scrollable view before persisting the %s tree",
    (status) => {
      // Arrange
      vi.useFakeTimers();
      const output = Object.assign(new PassThrough(), {
        rows: 6,
        columns: 100,
      });
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: vi.fn(),
      });
      const write = vi.spyOn(output, "write");
      const interrupt = vi.fn();
      const command = "npm run check -- --scroll";
      const progress = new TerminalProgress(output, true, false, 100, {
        input,
        onInterrupt: interrupt,
        command,
      });
      // Act
      progress.start(graph, id);
      progress.update({ taskId: id, package: ".", status: "running" });
      vi.advanceTimersByTime(160);
      input.emit("data", "\u0003");
      progress.update({ taskId: id, package: ".", status });
      const offset = write.mock.calls.length;
      expect(
        write.mock.calls
          .slice(0, offset)
          .some(([text]) => String(text).includes(command)),
      ).toBe(true);
      const live = stripVTControlCharacters(
        String(write.mock.calls.at(-1)![0]),
      ).split("\r\n");
      expect(live[0]).toBe(command);
      expect(live[1]).toBe("");
      expect(live[3]).toBe("");
      expect(live[4]).toBe(`Tasks: 1 | ${status}: 1`);
      expect(live[5]).toContain("Lines 1-1/1");
      progress.stop();
      const calls = write.mock.calls.length;
      progress.stop();
      // Assert
      expect(interrupt).toHaveBeenCalledOnce();
      expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
      const final = write.mock.calls
        .slice(offset)
        .map(([text]) => String(text))
        .join("");
      expect(final.indexOf("\u001b[?1049l")).toBeLessThan(
        final.indexOf(`check (${status}`),
      );
      expect(final).not.toContain(command);
      expect(final).not.toContain("Ctrl+C stop");
      expect(final).not.toContain("Tasks:");
      expect(vi.getTimerCount()).toBe(0);
      expect(write).toHaveBeenCalledTimes(calls);
    },
  );

  it("does not activate scrolling for plain output", () => {
    // Arrange
    const output = new PassThrough();
    const input = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
    const progress = new TerminalProgress(output, false, true, 100, {
      input,
      onInterrupt: vi.fn(),
    });
    // Act
    progress.start(graph, id);
    progress.stop();
    // Assert
    expect(input.setRawMode).not.toHaveBeenCalled();
    expect(input.listenerCount("data")).toBe(0);
  });

  it.each([true, false])(
    "scrolls through the configured task list and respects collapse=%s",
    (collapse) => {
      // Arrange
      const taskId = make<TaskId>();
      const root = taskId("root");
      const children = Array.from({ length: 10 }, (_, index) =>
        taskId(`child-${index}`),
      );
      const tasks = new Map<TaskId, CompiledTask>([
        [root, { id: root, package: ".", dependsOn: children, skip: false }],
        ...children.map((child): [TaskId, CompiledTask] => [
          child,
          {
            id: child,
            package: ".",
            dependsOn: [],
            skip: false,
            run: { kind: "npm", script: child },
          },
        ]),
      ]);
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: vi.fn(),
      });
      const output = Object.assign(new PassThrough(), {
        rows: 5,
        columns: 100,
      });
      const write = vi.spyOn(output, "write");
      const progress = new TerminalProgress(output, true, collapse, 5, {
        input,
        onInterrupt: vi.fn(),
      });
      // Act
      progress.start(tasks, root);
      progress.update({
        taskId: children[0]!,
        package: ".",
        status: "running",
      });
      input.emit("data", "\u001b[F");
      const end = stripVTControlCharacters(String(write.mock.calls.at(-1)![0]));
      for (const task of tasks.values())
        progress.update({ taskId: task.id, package: ".", status: "succeeded" });
      const offset = write.mock.calls.length;
      progress.stop();
      const final = stripVTControlCharacters(
        write.mock.calls
          .slice(offset)
          .map(([text]) => String(text))
          .join(""),
      );
      // Assert
      expect(end).toContain("child-3 (pending)");
      expect(end).toContain("... 6 more tasks");
      expect(end).toContain("Lines 5-6/6");
      expect(final).toContain("root (succeeded");
      if (collapse) {
        expect(final).not.toContain("child-");
        expect(final).not.toContain("more tasks");
      } else {
        expect(final).toContain("child-3 (succeeded");
        expect(final).toContain("... 6 more tasks");
      }
    },
  );

  it("prints the final tree once even when raw-mode restoration fails", () => {
    // Arrange
    const output = new PassThrough();
    const write = vi.spyOn(output, "write");
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn(),
    });
    const progress = new TerminalProgress(output, true, true, 100, {
      input,
      onInterrupt: vi.fn(),
    });
    progress.start(graph, id);
    const failure = new Error("raw restore failed");
    input.setRawMode.mockImplementationOnce(() => {
      throw failure;
    });
    // Act & Assert
    expect(() => progress.stop()).toThrow(failure);
    expect(String(write.mock.calls.at(-1)![0])).toContain("check (pending)");
    const count = write.mock.calls.length;
    progress.stop();
    expect(write).toHaveBeenCalledTimes(count);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
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
          root,
          { id: root, package: ".", dependsOn: [build, test], skip: false },
        ],
        [
          build,
          { id: build, package: ".", dependsOn: [clean, compile], skip: false },
        ],
        ...[clean, compile, test].map((task): [TaskId, CompiledTask] => [
          task,
          {
            id: task,
            package: ".",
            dependsOn: [],
            skip: false,
            run: { kind: "npm", script: task },
          },
        ]),
      ]);
      const output = Object.assign(new PassThrough(), { rows: 1, columns: 80 });
      let text = "";
      output.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      const progress = new TerminalProgress(output, true, false);
      // Act
      progress.start(tasks, root);
      for (const task of [clean, compile, build])
        progress.update({
          taskId: task,
          package: ".",
          status: "succeeded",
          durationMs: 100,
        });
      progress.update({ taskId: test, package: ".", status });
      progress.update({ taskId: root, package: ".", status: "blocked" });
      const offset = text.length;
      progress.stop();
      const final = stripVTControlCharacters(text.slice(offset));
      // Assert
      expect(final).toContain("validate (blocked");
      expect(final).toContain("  \u2714 build (succeeded, 0.1s)");
      expect(final).toContain("    \u2714 clean (succeeded, 0.1s)");
      expect(final).toContain("    \u2714 compile (succeeded, 0.1s)");
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
        taskId(`child-${index}`),
      );
      const tasks = new Map<TaskId, CompiledTask>([
        [root, { id: root, package: ".", dependsOn: children, skip: false }],
        ...children.map((child): [TaskId, CompiledTask] => [
          child,
          {
            id: child,
            package: ".",
            dependsOn: [],
            skip: false,
            run: { kind: "npm", script: child },
          },
        ]),
      ]);
      const output = Object.assign(new PassThrough(), { rows: 3, columns: 80 });
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
      expect(final).toContain(`... ${106 - (limit ?? 100)} more tasks`);
    },
  );

  it.each([
    { noColor: undefined, forceColor: undefined, colored: true },
    { noColor: "", forceColor: undefined, colored: false },
    { noColor: "1", forceColor: "1", colored: false },
    { noColor: undefined, forceColor: "0", colored: false },
    { noColor: undefined, forceColor: "1", colored: true },
  ])(
    "respects color preferences: $noColor / $forceColor",
    ({ noColor, forceColor, colored }) => {
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
        progress.update({ taskId: id, package: ".", status: "succeeded" });
      } finally {
        progress.stop();
      }
      // Assert
      expect(text.includes("\u001b[32m")).toBe(colored);
      expect(stripVTControlCharacters(text)).toContain(
        "\u2714 check (succeeded)",
      );
    },
  );
  it.each([undefined, 12])(
    "redraws live output at terminal height %s and releases the animation on stop",
    (rows) => {
      // Arrange
      vi.useFakeTimers();
      const output = Object.assign(new PassThrough(), {
        ...(rows === undefined ? {} : { rows }),
        columns: 80,
      });
      let text = "";
      output.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      const progress = new TerminalProgress(output, true);
      // Act
      progress.start(graph, id);
      progress.update({ taskId: id, package: ".", status: "running" });
      vi.advanceTimersByTime(160);
      progress.update({
        taskId: id,
        package: ".",
        status: "succeeded",
        durationMs: 160,
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
      expect(text).toContain("\u001b[");
      expect(text).toBe(settled);
      expect(vi.getTimerCount()).toBe(0);
      expect(text).not.toContain("\u001b[?25l");
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
    progress.update({ taskId: id, package: ".", status: "ready" });
    progress.update({ taskId: id, package: ".", status: "running" });
    progress.update({
      taskId: id,
      package: ".",
      status: "failed",
      durationMs: 100,
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
    expect(() =>
      progress.update({ taskId: id, package: ".", status: "running" }),
    ).toThrow("has not started");
    progress.start(graph, id);
    expect(progress.summary()).toBe("Tasks: 1 | pending: 1");
    expect(() => progress.start(graph, id)).toThrow("already started");
  });
});
