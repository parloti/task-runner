import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ScrollView } from "./scroll-view.js";

function terminal(command?: string) {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(),
  });
  const output = Object.assign(new PassThrough(), { rows: 7, columns: 100 });
  const write = vi.spyOn(output, "write");
  const interrupt = vi.fn();
  const view = new ScrollView(output, {
    input,
    onInterrupt: interrupt,
    ...(command === undefined ? {} : { command }),
  });
  const frame = () =>
    stripVTControlCharacters(String(write.mock.calls.at(-1)![0]));
  const press = (text: string | Buffer) => input.emit("data", text);
  return { input, output, view, write, frame, press, interrupt };
}

const lines = Array.from(
  { length: 20 },
  (_, index) => `task ${index + 1}`,
).join("\n");
const summary = "Tasks: 20 | pending: 20";

describe("scrollable terminal viewport", () => {
  it("pins a full wrapped command above the scrolling tasks and footer", () => {
    // Arrange
    const command =
      "npm run validate -- --scroll --collapse false --concurrency 4 --max-tasks 1000";
    const { view, output, press, frame } = terminal(command);
    output.columns = 41;
    output.rows = 11;
    view.start();
    // Act
    view.render(lines, summary);
    const initial = frame().split("\r\n");
    press("\u001b[F");
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
    expect(frame().split("\r\n")[0]).toBe(command);
    expect(frame()).toContain("Lines 15-20/20");
    view.stop();
  });

  it.each([1, 2, 3, 4, 5, 6, 7])(
    "reserves task space on a %i-row terminal even with a long header",
    (rows) => {
      // Arrange
      const { view, output, press, frame } = terminal("a".repeat(200));
      output.rows = rows;
      output.columns = 11;
      view.start();
      // Act
      view.render(lines, summary);
      press("\u001b[F");
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
    const { view, frame } = terminal("npm\u001b[2J run\nvalidate\t\u202e");
    view.start();
    // Act
    view.render(lines, summary);
    // Assert
    expect(frame().split("\r\n")[0]).toBe("npm run validate  ");
    view.stop();
  });
  it.each([
    ["\u001b[B", 2],
    ["\u001bOB", 2],
    ["\u001b[A", 1],
    ["\u001bOA", 1],
    ["\u001b[6~", 5],
    ["\u001b[5~", 1],
    ["\u001b[F", 17],
    ["\u001bOF", 17],
    ["\u001b[4~", 17],
    ["\u001b[8~", 17],
    ["\u001b[H", 1],
    ["\u001bOH", 1],
    ["\u001b[1~", 1],
    ["\u001b[7~", 1],
    ["\u001b[<65;10;3M", 4],
    ["\u001b[<64;10;3M", 1],
  ] as const)("navigates %j without appending history", (key, first) => {
    // Arrange
    const { view, press, frame, write } = terminal();
    view.start();
    view.render(lines, summary);
    // Act
    press(key);
    // Assert
    expect(frame()).toBe(
      [first, first + 1, first + 2, first + 3]
        .map((number) => `task ${number}`)
        .join("\r\n") +
        `\r\n\r\n${summary}\r\nLines ${first}-${first + 3}/20 | Up/Down PgUp/PgDn Home/End Wheel | Ctrl+C stop`,
    );
    const patch = String(write.mock.calls.at(-1)![0]);
    expect(patch.startsWith("\u001b[H")).toBe(true);
    expect(patch).not.toMatch(/\n$/);
    expect(patch.split("\r\n")).toHaveLength(7);
    view.stop();
  });

  it("handles split/coalesced input, repeated boundary keys, and unsupported input", () => {
    // Arrange
    const { view, press, frame, write } = terminal();
    view.start();
    view.render(lines, summary);
    // Act
    press(Buffer.from("\u001b"));
    press("[");
    press("B\u001b[B");
    // Assert
    expect(frame()).toContain("Lines 3-6/20");
    // Act
    press("\u001b[<65;1;");
    press("1M");
    // Assert
    expect(frame()).toContain("Lines 6-9/20");
    // Act
    press("\u001b[F\u001b[B\u001b[6~");
    // Assert
    expect(frame()).toContain("Lines 17-20/20");
    // Act
    press("\u001b[5~");
    // Assert
    expect(frame()).toContain("Lines 13-16/20");
    // Act
    press("\u001b[H\u001b[A");
    const count = write.mock.calls.length;
    press("hello\u001b[Z\u001b[<0;1;1M\u001b[<65;1;1m\u001bx");
    press("\u001b[" + "1".repeat(100));
    press("\u001b[B");
    // Assert
    expect(write.mock.calls.length).toBe(count + 1);
    expect(frame()).toContain("Lines 2-5/20");
    view.stop();
  });

  it("uses Ctrl+C for cancellation even following an incomplete sequence", () => {
    // Arrange
    const { view, press, interrupt } = terminal();
    view.start();
    view.render(lines, summary);
    // Act
    press("\u001b[\u0003");
    // Assert
    expect(interrupt).toHaveBeenCalledOnce();
    view.stop();
  });

  it("re-clamps on resize and collapse and erases the old viewport", () => {
    // Arrange
    const { view, press, output, frame, write } = terminal();
    view.start();
    view.render(lines, summary);
    press("\u001b[F");
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
    expect(String(write.mock.calls.at(-1)![0]).endsWith("\u001b[J")).toBe(true);
    view.stop();
  });

  it("wraps colored wide labels within physical screen bounds", () => {
    // Arrange
    const { view, output, press, frame } = terminal();
    output.columns = 9;
    output.rows = 5;
    view.start();
    // Act
    view.render(
      "\u001b[32m12345678901234567890\u001b[39m\n\u754c\u754c\u754c\u754c\u754c",
      summary,
    );
    // Assert
    expect(frame().split("\r\n").slice(0, 2)).toEqual(["12345678", "90123456"]);
    // Act
    press("\u001b[F");
    // Assert
    expect(frame().split("\r\n").slice(0, 2)).toEqual([
      "\u754c\u754c\u754c\u754c",
      "\u754c",
    ]);
    expect(frame().split("\r\n")).toHaveLength(5);
    view.stop();
  });

  it("handles zero and one-cell terminals without scrolling past the bottom", () => {
    // Arrange
    const { view, output, press, frame } = terminal();
    output.rows = 0;
    output.columns = 0;
    view.start();
    // Act
    view.render("abc", summary);
    // Assert
    expect(frame()).toBe("a");
    // Act
    press("\u001b[F");
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
    expect(String(write.mock.calls.at(-1)![0]).split("\r\n")).toHaveLength(24);
    view.stop();
  });

  it.each([true, false])(
    "restores prior input modes, listeners, and screen exactly once: raw=%s",
    (raw) => {
      // Arrange
      const { view, input, output, write, press, interrupt } = terminal();
      input.isRaw = raw;
      if (raw) input.resume();
      else input.pause();
      const flow = input.readableFlowing;
      const listener = vi.fn();
      input.on("data", listener);
      const resize = vi.fn();
      output.on("resize", resize);
      view.start();
      // Act
      view.render(lines, summary);
      view.stop();
      const calls = write.mock.calls.length;
      view.stop();
      press("\u0003");
      // Assert
      expect(input.setRawMode.mock.calls).toEqual([[true], [raw]]);
      expect(input.readableFlowing).toBe(flow);
      expect(input.listeners("data")).toEqual([listener]);
      expect(output.listeners("resize")).toEqual([resize]);
      expect(interrupt).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledTimes(calls);
      expect(write.mock.calls[0]![0]).toBe(
        "\u001b[?1049h\u001b[?25l\u001b[?1000h\u001b[?1006h",
      );
      expect(write.mock.calls.at(-1)![0]).toBe(
        "\u001b[?1006l\u001b[?1000l\u001b[?25h\u001b[?1049l",
      );
    },
  );

  it.each(["not-tty", "no-raw"] as const)(
    "rejects unavailable input before changing the screen: %s",
    (reason) => {
      // Arrange
      const input =
        reason === "not-tty"
          ? new PassThrough()
          : Object.assign(new PassThrough(), { isTTY: true });
      const output = new PassThrough();
      const write = vi.spyOn(output, "write");
      const view = new ScrollView(output, { input, onInterrupt: vi.fn() });
      // Act & Assert
      expect(() => view.start()).toThrow(
        "--scroll requires interactive terminal input",
      );
      view.stop();
      expect(write).not.toHaveBeenCalled();
    },
  );

  it.each(["raw", "write", "resume"] as const)(
    "rolls back a setup failure from %s",
    (boundary) => {
      // Arrange
      const { view, input, output, write } = terminal();
      const failure = new Error("terminal setup failed");
      if (boundary === "raw")
        input.setRawMode.mockImplementationOnce(() => {
          throw failure;
        });
      if (boundary === "write")
        write.mockImplementationOnce(() => {
          throw failure;
        });
      if (boundary === "resume")
        vi.spyOn(input, "resume").mockImplementationOnce(() => {
          throw failure;
        });
      // Act & Assert
      expect(() => view.start()).toThrow(failure);
      expect(input.setRawMode).toHaveBeenLastCalledWith(false);
      expect(input.listenerCount("data")).toBe(0);
      expect(output.listenerCount("resize")).toBe(0);
      expect(String(write.mock.calls.at(-1)![0])).toContain("\u001b[?1049l");
      view.stop();
    },
  );

  it("preserves setup and cleanup failures while still restoring the screen", () => {
    // Arrange
    const { view, input, write } = terminal();
    const setup = new Error("raw setup failed");
    const cleanup = new Error("raw restore failed");
    input.setRawMode
      .mockImplementationOnce(() => {
        throw setup;
      })
      .mockImplementationOnce(() => {
        throw cleanup;
      });
    // Act & Assert
    expect(() => view.start()).toThrow(
      new AggregateError(
        [setup, cleanup],
        "Scrollable terminal setup and cleanup failed",
      ),
    );
    expect(String(write.mock.calls.at(-1)![0])).toContain("\u001b[?1049l");
  });

  it("restores the normal screen even when pausing input fails", () => {
    // Arrange
    const { view, input, write } = terminal();
    view.start();
    const failure = new Error("pause failed");
    vi.spyOn(input, "pause").mockImplementationOnce(() => {
      throw failure;
    });
    // Act & Assert
    expect(() => view.stop()).toThrow(failure);
    expect(String(write.mock.calls.at(-1)![0])).toContain("\u001b[?1049l");
  });
});
