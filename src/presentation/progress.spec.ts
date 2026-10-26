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
      const output = Object.assign(new PassThrough(), { columns: 80, rows: 1 });
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
      progress.update({ package: ".", status, taskId: id });
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
        new RegExp(String.raw`^\n[^\n]+ check \(${status}\)\n\n$`),
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
        columns: 100,
        rows: 6,
      });
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: vi.fn(),
      });
      const write = vi.spyOn(output, "write");
      const interrupt = vi.fn();
      const command = "npm run check -- --scroll";
      const progress = new TerminalProgress(output, true, false, 100, {
        command,
        input,
        onInterrupt: interrupt,
      });
      // Act
      progress.start(graph, id);
      progress.update({ package: ".", status: "running", taskId: id });
      vi.advanceTimersByTime(160);
      input.emit("data", "\u{3}");
      progress.update({ package: ".", status, taskId: id });
      const offset = write.mock.calls.length;
      expect(
        write.mock.calls
          .slice(0, offset)
          .some(([text]) => String(text).includes(command)),
      ).toBe(true);
      const live = stripVTControlCharacters(
        String(write.mock.calls.at(-1)?.[0]),
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
      expect(final.indexOf("\u{1B}[?1049l")).toBeLessThan(
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
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: vi.fn(),
      });
      const output = Object.assign(new PassThrough(), {
        columns: 100,
        rows: 5,
      });
      const write = vi.spyOn(output, "write");
      const progress = new TerminalProgress(output, true, collapse, 5, {
        input,
        onInterrupt: vi.fn(),
      });
      // Act
      progress.start(tasks, root);
      const firstChild = children.at(0);
      if (firstChild === undefined)
        throw new Error("Expected the progress graph to have a child");
      progress.update({ package: ".", status: "running", taskId: firstChild });
      input.emit("data", "\u{1B}[F");
      const end = stripVTControlCharacters(
        String(write.mock.calls.at(-1)?.[0]),
      );
      for (const task of tasks.values())
        progress.update({ package: ".", status: "succeeded", taskId: task.id });
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
      expect(final.includes("child-")).toBe(!collapse);
      expect(final.includes("more tasks")).toBe(!collapse);
      expect(final.includes("child-3 (succeeded")).toBe(!collapse);
      expect(final.includes("... 6 more tasks")).toBe(!collapse);
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
    expect(() => {
      progress.stop();
    }).toThrow(failure);
    expect(String(write.mock.calls.at(-1)?.[0])).toContain("check (pending)");
    const count = write.mock.calls.length;
    progress.stop();
    expect(write).toHaveBeenCalledTimes(count);
  });
});
