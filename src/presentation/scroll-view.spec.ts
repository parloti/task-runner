import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { ScrollView } from "./scroll-view";

/**
 * Create a fake interactive terminal for scroll view tests.
 * @param command Optional invocation text displayed by the view.
 * @returns Input and output streams with terminal capabilities.
 * @example `terminal("task-runner run build")` creates a terminal fixture.
 */
function terminal(command?: string) {
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    isTTY: true,
    setRawMode: vi.fn(),
  });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 7 });
  const write = vi.spyOn(output, "write");
  const interrupt = vi.fn();
  const view = new ScrollView(output, {
    input,
    onInterrupt: interrupt,
    ...(command !== undefined && { command }),
  });
  const frame = () =>
    stripVTControlCharacters(String(write.mock.calls.at(-1)?.[0]));
  const press = (text: Buffer | string) => input.emit("data", text);
  return { frame, input, interrupt, output, press, view, write };
}

const lines = Array.from(
  { length: 20 },
  (_, index) => `task ${String(index + 1)}`,
).join("\n");
const summary = "Tasks: 20 | pending: 20";

describe("scrollable terminal viewport", () => {
  it("pins a full wrapped command above the scrolling tasks and footer", () => {
    // Arrange
    const command =
      "npm run validate -- --scroll --collapse false --concurrency 4 --max-tasks 1000";
    const { frame, output, press, view } = terminal(command);
    output.columns = 41;
    output.rows = 11;
    view.start();
    // Act
    view.render(lines, summary);
    const initial = frame().split("\r\n");
    press("\u{1B}[F");
    const end = frame().split("\r\n");
    // Assert
    expect(initial.slice(0, 2).join("")).toBe(command);
    expect(end.slice(0, 2)).toEqual(initial.slice(0, 2));
    expect(initial[2]).toBe("");
    expect(initial[3]).toBe("task 1");
    expect(end[3]).toBe("task 16");
    expect(initial[8]).toBe("");
    expect(initial[9]).toBe(summary);
    expect(initial[10]).toContain("Lines 1-5/20");
    expect(end[10]).toContain("Lines 16-20/20");
    // Act
    output.columns = 100;
    output.emit("resize");
    // Assert
    expect(frame().split("\r\n", 1)[0]).toBe(command);
    expect(frame()).toContain("Lines 15-20/20");
    view.stop();
  });

  it.each([1, 2, 3, 4, 5, 6, 7])(
    "reserves task space on a %i-row terminal even with a long header",
    (rows) => {
      // Arrange
      const { frame, output, press, view } = terminal("a".repeat(200));
      output.rows = rows;
      output.columns = 11;
      view.start();
      // Act
      view.render(lines, summary);
      press("\u{1B}[F");
      // Assert
      const rendered = frame().split("\r\n");
      expect(rendered).toHaveLength(rows);
      expect(rendered).toContain("task 20");
      expect(frame().includes("aaaaaaaaaa")).toBe(rows >= 6);
      view.stop();
    },
  );

  it("sanitizes terminal controls in command headers", () => {
    // Arrange
    const { frame, view } = terminal("npm\u{1B}[2J run\nvalidate\t\u{202E}");
    view.start();
    // Act
    view.render(lines, summary);
    // Assert
    expect(frame().split("\r\n", 1)[0]).toBe("npm run validate  ");
    view.stop();
  });
  it.each([
    ["\u{1B}[B", 2],
    ["\u{1B}OB", 2],
    ["\u{1B}[A", 1],
    ["\u{1B}OA", 1],
    ["\u{1B}[6~", 5],
    ["\u{1B}[5~", 1],
    ["\u{1B}[F", 17],
    ["\u{1B}OF", 17],
    ["\u{1B}[4~", 17],
    ["\u{1B}[8~", 17],
    ["\u{1B}[H", 1],
    ["\u{1B}OH", 1],
    ["\u{1B}[1~", 1],
    ["\u{1B}[7~", 1],
    ["\u{1B}[<65;10;3M", 4],
    ["\u{1B}[<64;10;3M", 1],
  ] as const)("navigates %j without appending history", (key, first) => {
    // Arrange
    const { frame, press, view, write } = terminal();
    view.start();
    view.render(lines, summary);
    // Act
    press(key);
    // Assert
    expect(frame()).toBe(
      [first, first + 1, first + 2, first + 3]
        .map((number) => `task ${String(number)}`)
        .join("\r\n") +
        `\r\n\r\n${summary}\r\nLines ${String(first)}-${String(first + 3)}/20 | Up/Down PgUp/PgDn Home/End Wheel | Ctrl+C stop`,
    );
    const patch = String(write.mock.calls.at(-1)?.[0]);
    expect(patch.startsWith("\u{1B}[H")).toBe(true);
    expect(patch).not.toMatch(/\n$/);
    expect(patch.split("\r\n")).toHaveLength(7);
    view.stop();
  });

  it("handles split/coalesced input, repeated boundary keys, and unsupported input", () => {
    // Arrange
    const { frame, press, view, write } = terminal();
    view.start();
    view.render(lines, summary);
    // Act
    press(Buffer.from("\u{1B}"));
    press("[");
    press("B\u{1B}[B");
    // Assert
    expect(frame()).toContain("Lines 3-6/20");
    // Act
    press("\u{1B}[<65;1;");
    press("1M");
    // Assert
    expect(frame()).toContain("Lines 6-9/20");
    // Act
    press("\u{1B}[F\u{1B}[B\u{1B}[6~");
    // Assert
    expect(frame()).toContain("Lines 17-20/20");
    // Act
    press("\u{1B}[5~");
    // Assert
    expect(frame()).toContain("Lines 13-16/20");
    // Act
    press("\u{1B}[H\u{1B}[A");
    const count = write.mock.calls.length;
    press("hello\u{1B}[Z\u{1B}[<0;1;1M\u{1B}[<65;1;1m\u{1B}x");
    press("\u{1B}[" + "1".repeat(100));
    press("\u{1B}[B");
    // Assert
    expect(write.mock.calls.length).toBe(count + 1);
    expect(frame()).toContain("Lines 2-5/20");
    view.stop();
  });

  it("uses Ctrl+C for cancellation even following an incomplete sequence", () => {
    // Arrange
    const { interrupt, press, view } = terminal();
    view.start();
    view.render(lines, summary);
    // Act
    press("\u{1B}[\u{3}");
    // Assert
    expect(interrupt).toHaveBeenCalledOnce();
    view.stop();
  });

  it("re-clamps on resize and collapse and erases the old viewport", () => {
    // Arrange
    const { frame, output, press, view, write } = terminal();
    view.start();
    view.render(lines, summary);
    press("\u{1B}[F");
    // Act
    output.rows = 12;
    output.emit("resize");
    // Assert
    expect(frame()).toContain("Lines 12-20/20");
    // Act
    view.render("root (succeeded)", "Tasks: 1 | succeeded: 1");
    // Assert
    expect(frame()).toContain("root (succeeded)");
    expect(frame()).not.toContain("task ");
    expect(frame()).toContain("Lines 1-1/1");
    expect(String(write.mock.calls.at(-1)?.[0]).endsWith("\u{1B}[J")).toBe(
      true,
    );
    view.stop();
  });

  it("wraps colored wide labels within physical screen bounds", () => {
    // Arrange
    const { frame, output, press, view } = terminal();
    output.columns = 9;
    output.rows = 5;
    view.start();
    // Act
    view.render(
      "\u{1B}[32m12345678901234567890\u{1B}[39m\n\u{754C}\u{754C}\u{754C}\u{754C}\u{754C}",
      summary,
    );
    // Assert
    expect(frame().split("\r\n").slice(0, 2)).toEqual(["12345678", "90123456"]);
    // Act
    press("\u{1B}[F");
    // Assert
    expect(frame().split("\r\n").slice(0, 2)).toEqual([
      "\u{754C}\u{754C}\u{754C}\u{754C}",
      "\u{754C}",
    ]);
    expect(frame().split("\r\n")).toHaveLength(5);
    view.stop();
  });

  it("handles zero and one-cell terminals without scrolling past the bottom", () => {
    // Arrange
    const { frame, output, press, view } = terminal();
    output.rows = 0;
    output.columns = 0;
    view.start();
    // Act
    view.render("abc", summary);
    // Assert
    expect(frame()).toBe("a");
    // Act
    press("\u{1B}[F");
    // Assert
    expect(frame()).toBe("c");
    view.stop();
  });

  it("uses default dimensions when the stream does not report them", () => {
    // Arrange
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn(),
    });
    const output = new PassThrough();
    const write = vi.spyOn(output, "write");
    const view = new ScrollView(output, { input, onInterrupt: vi.fn() });
    view.start();
    // Act
    view.render(lines, summary);
    // Assert
    expect(String(write.mock.calls.at(-1)?.[0]).split("\r\n")).toHaveLength(24);
    view.stop();
  });
});
