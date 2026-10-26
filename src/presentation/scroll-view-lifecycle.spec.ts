import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { ScrollView } from "./scroll-view";

/**
 * Create a fake interactive terminal for scroll view tests.
 * @returns Input and output streams with terminal capabilities.
 * @example `terminal()` creates an interactive terminal fixture.
 */
function terminal() {
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    isTTY: true,
    setRawMode: vi.fn(),
  });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 7 });
  const write = vi.spyOn(output, "write");
  const interrupt = vi.fn();
  const view = new ScrollView(output, { input, onInterrupt: interrupt });
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
  it.each([true, false])(
    "restores prior input modes, listeners, and screen exactly once: raw=%s",
    (raw) => {
      // Arrange
      const { input, interrupt, output, press, view, write } = terminal();
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
      press("\u{3}");
      // Assert
      expect(input.setRawMode.mock.calls).toEqual([[true], [raw]]);
      expect(input.readableFlowing).toBe(flow);
      expect(input.listeners("data")).toEqual([listener]);
      expect(output.listeners("resize")).toEqual([resize]);
      expect(interrupt).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledTimes(calls);
      expect(write.mock.calls[0]?.[0]).toBe(
        "\u{1B}[?1049h\u{1B}[?25l\u{1B}[?1000h\u{1B}[?1006h",
      );
      expect(write.mock.calls.at(-1)?.[0]).toBe(
        "\u{1B}[?1006l\u{1B}[?1000l\u{1B}[?25h\u{1B}[?1049l",
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
      expect(() => {
        view.start();
      }).toThrow("--scroll requires interactive terminal input");
      view.stop();
      expect(write).not.toHaveBeenCalled();
    },
  );

  it.each(["raw", "write", "resume"] as const)(
    "rolls back a setup failure from %s",
    (boundary) => {
      // Arrange
      const { input, output, view, write } = terminal();
      const failure = new Error("terminal setup failed");
      switch (boundary) {
        case "raw": {
          input.setRawMode.mockImplementationOnce(() => {
            throw failure;
          });
          break;
        }
        case "resume": {
          vi.spyOn(input, "resume").mockImplementationOnce(() => {
            throw failure;
          });
          break;
        }
        case "write": {
          write.mockImplementationOnce(() => {
            throw failure;
          });
          break;
        }
        // No default
      }
      // Act & Assert
      expect(() => {
        view.start();
      }).toThrow(failure);
      expect(input.setRawMode).toHaveBeenLastCalledWith(false);
      expect(input.listenerCount("data")).toBe(0);
      expect(output.listenerCount("resize")).toBe(0);
      expect(String(write.mock.calls.at(-1)?.[0])).toContain("\u{1B}[?1049l");
      view.stop();
    },
  );

  it("preserves setup and cleanup failures while still restoring the screen", () => {
    // Arrange
    const { input, view, write } = terminal();
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
    expect(() => {
      view.start();
    }).toThrow(
      new AggregateError(
        [setup, cleanup],
        "Scrollable terminal setup and cleanup failed",
      ),
    );
    expect(String(write.mock.calls.at(-1)?.[0])).toContain("\u{1B}[?1049l");
  });

  it("restores the normal screen even when pausing input fails", () => {
    // Arrange
    const { input, view, write } = terminal();
    view.start();
    const failure = new Error("pause failed");
    vi.spyOn(input, "pause").mockImplementationOnce(() => {
      throw failure;
    });
    // Act & Assert
    expect(() => {
      view.stop();
    }).toThrow(failure);
    expect(String(write.mock.calls.at(-1)?.[0])).toContain("\u{1B}[?1049l");
  });
});
