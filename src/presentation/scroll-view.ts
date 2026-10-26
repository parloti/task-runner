import type { Readable } from "node:stream";

import { stripVTControlCharacters } from "node:util";
import wrapAnsi from "wrap-ansi";

import { setTerminalRawMode } from "./scroll-view-lifecycle";

export interface ScrollOptions {
  readonly command?: string;
  readonly input: ScrollInput;
  readonly onInterrupt: () => void;
}

interface ScrollInput extends Readable {
  readonly isRaw?: boolean;
  readonly isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

interface ScrollOutput extends NodeJS.WritableStream {
  readonly columns?: number;
  readonly rows?: number;
}

const enter = "\u{1B}[?1049h\u{1B}[?25l\u{1B}[?1000h\u{1B}[?1006h";
const leave = "\u{1B}[?1006l\u{1B}[?1000l\u{1B}[?25h\u{1B}[?1049l";
const wrap = (text: string, width: number): string[] =>
  wrapAnsi(text, width, { hard: true, trim: false, wordWrap: false }).split(
    "\n",
  );

export class ScrollView {
  private active = false;
  private lineCount = 1;
  private offset = 0;
  private pageSize = 1;
  private pending = "";
  private summary = "";
  private text = "";
  private wasFlowing = false;
  private wasRaw = false;

  constructor(
    private readonly output: ScrollOutput,
    private readonly options: ScrollOptions,
  ) {}

  render(text: string, summary: string): void {
    this.text = text;
    this.summary = summary;
    this.draw();
  }

  start(): void {
    const { input } = this.options;
    if (input.isTTY !== true || input.setRawMode === undefined)
      throw new Error("--scroll requires interactive terminal input");
    this.wasRaw = input.isRaw === true;
    this.wasFlowing = input.readableFlowing === true;
    this.active = true;
    try {
      setTerminalRawMode(input, true);
      this.output.write(enter);
      input.on("data", this.onData);
      this.output.on("resize", this.draw);
      input.resume();
    } catch (error) {
      try {
        this.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Scrollable terminal setup and cleanup failed",
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    const { input } = this.options;
    input.off("data", this.onData);
    this.output.off("resize", this.draw);
    this.pending = "";
    try {
      setTerminalRawMode(input, this.wasRaw);
    } finally {
      try {
        if (!this.wasFlowing) input.pause();
      } finally {
        this.output.write(leave);
      }
    }
  }

  private readonly draw = (): void => {
    const height = Math.max(1, this.output.rows ?? 24);
    // Leave a spare column so terminals never auto-wrap at the right margin.
    const width = Math.max(1, (this.output.columns ?? 80) - 1);
    const lines = wrap(this.text, width);
    const footerRows = Math.min(2, height - 1);
    const footerGap = height >= 4 ? 1 : 0;
    const headerSpace = height - footerRows - footerGap - 1;
    const header =
      this.options.command === undefined || headerSpace < 2
        ? []
        : wrap(
            stripVTControlCharacters(this.options.command).replaceAll(
              /[\p{Cc}\p{Cf}]/gu,
              " ",
            ),
            width,
          ).slice(0, headerSpace - 1);
    if (header.length > 0) header.push("");
    this.lineCount = lines.length;
    this.pageSize = Math.max(
      1,
      height - header.length - footerRows - footerGap,
    );
    this.offset = Math.max(
      0,
      Math.min(this.offset, lines.length - this.pageSize),
    );
    const visible = lines.slice(this.offset, this.offset + this.pageSize);
    if (footerRows > 0) {
      const range = `Lines ${String(this.offset + 1)}-${String(this.offset + visible.length)}/${String(lines.length)}`;
      const footer = `${range} | Up/Down PgUp/PgDn Home/End Wheel | Ctrl+C stop`;
      while (visible.length < this.pageSize) visible.push("");
      if (footerGap > 0) visible.push("");
      if (footerRows > 1) visible.push(wrap(this.summary, width)[0] ?? "");
      visible.push(wrap(footer, width)[0] ?? "");
    }
    this.output.write(
      `\u{1B}[H${[...header, ...visible].map((line) => `${line}\u{1B}[K`).join("\r\n")}\u{1B}[J`,
    );
  };

  private navigate(sequence: string): void {
    switch (sequence) {
      case "\u{3}": {
        this.options.onInterrupt();
        return;
      }
      case "\u{1B}[1~":
      case "\u{1B}[7~":
      case "\u{1B}[H":
      case "\u{1B}OH": {
        this.offset = 0;
        break;
      }
      case "\u{1B}[4~":
      case "\u{1B}[8~":
      case "\u{1B}[F":
      case "\u{1B}OF": {
        this.offset = this.lineCount;
        break;
      }
      case "\u{1B}[5~": {
        this.offset -= this.pageSize;
        break;
      }
      case "\u{1B}[6~": {
        this.offset += this.pageSize;
        break;
      }
      case "\u{1B}[A":
      case "\u{1B}OA": {
        this.offset--;
        break;
      }
      case "\u{1B}[B":
      case "\u{1B}OB": {
        this.offset++;
        break;
      }
      default: {
        const mouse = /^<(64|65);\d+;\d+M$/.exec(sequence.slice(2));
        if (mouse === null) return;
        this.offset += mouse[1] === "64" ? -3 : 3;
      }
    }
    this.draw();
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.pending += chunk.toString();
    while (this.pending.length > 0) {
      if (!this.pending.startsWith("\u{1B}")) {
        const character = this.pending.charAt(0);
        this.pending = this.pending.slice(1);
        this.navigate(character);
        continue;
      }
      const sequence = /^(?:\[[0-?]*[ -/]*[@-~]|O[@-~])/.exec(
        this.pending.slice(1),
      );
      if (sequence !== null) {
        this.pending = this.pending.slice(sequence[0].length + 1);
        this.navigate(`\u{1B}${sequence[0]}`);
      } else if (
        this.pending.length <= 64 &&
        /^(?:\[[0-?]*[ -/]*|O?)$/.test(this.pending.slice(1))
      ) {
        break;
      } else {
        this.pending = this.pending.slice(1);
      }
    }
  };
}
