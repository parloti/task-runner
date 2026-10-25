import type { Readable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import wrapAnsi from "wrap-ansi";

export interface ScrollInput extends Readable {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface ScrollOutput extends NodeJS.WritableStream {
  readonly rows?: number;
  readonly columns?: number;
}

export interface ScrollOptions {
  readonly input: ScrollInput;
  readonly onInterrupt: () => void;
  readonly command?: string;
}

const enter = "\u001b[?1049h\u001b[?25l\u001b[?1000h\u001b[?1006h";
const leave = "\u001b[?1006l\u001b[?1000l\u001b[?25h\u001b[?1049l";
const wrap = (text: string, width: number): string[] =>
  wrapAnsi(text, width, { hard: true, wordWrap: false, trim: false }).split(
    "\n",
  );

export class ScrollView {
  private active = false;
  private wasRaw = false;
  private wasFlowing = false;
  private pending = "";
  private text = "";
  private summary = "";
  private offset = 0;
  private pageSize = 1;
  private lineCount = 1;

  constructor(
    private readonly output: ScrollOutput,
    private readonly options: ScrollOptions,
  ) {}

  start(): void {
    const { input } = this.options;
    if (input.isTTY !== true || input.setRawMode === undefined)
      throw new Error("--scroll requires interactive terminal input");
    this.wasRaw = input.isRaw === true;
    this.wasFlowing = input.readableFlowing === true;
    this.active = true;
    try {
      input.setRawMode(true);
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

  render(text: string, summary: string): void {
    this.text = text;
    this.summary = summary;
    this.draw();
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
            stripVTControlCharacters(this.options.command).replace(
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
      const range = `Lines ${this.offset + 1}-${this.offset + visible.length}/${lines.length}`;
      const footer = `${range} | Up/Down PgUp/PgDn Home/End Wheel | Ctrl+C stop`;
      while (visible.length < this.pageSize) visible.push("");
      if (footerGap > 0) visible.push("");
      if (footerRows > 1) visible.push(wrap(this.summary, width)[0]!);
      visible.push(wrap(footer, width)[0]!);
    }
    this.output.write(
      `\u001b[H${[...header, ...visible].map((line) => `${line}\u001b[K`).join("\r\n")}\u001b[J`,
    );
  };

  private navigate(sequence: string): void {
    switch (sequence) {
      case "\u0003":
        this.options.onInterrupt();
        return;
      case "\u001b[A":
      case "\u001bOA":
        this.offset--;
        break;
      case "\u001b[B":
      case "\u001bOB":
        this.offset++;
        break;
      case "\u001b[5~":
        this.offset -= this.pageSize;
        break;
      case "\u001b[6~":
        this.offset += this.pageSize;
        break;
      case "\u001b[H":
      case "\u001bOH":
      case "\u001b[1~":
      case "\u001b[7~":
        this.offset = 0;
        break;
      case "\u001b[F":
      case "\u001bOF":
      case "\u001b[4~":
      case "\u001b[8~":
        this.offset = this.lineCount;
        break;
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
      if (this.pending[0] !== "\u001b") {
        const character = this.pending[0]!;
        this.pending = this.pending.slice(1);
        this.navigate(character);
        continue;
      }
      const sequence = /^(?:\[[0-?]*[ -/]*[@-~]|O[@-~])/.exec(
        this.pending.slice(1),
      );
      if (sequence !== null) {
        this.pending = this.pending.slice(sequence[0].length + 1);
        this.navigate(`\u001b${sequence[0]}`);
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

  stop(): void {
    if (!this.active) return;
    this.active = false;
    const { input } = this.options;
    input.off("data", this.onData);
    this.output.off("resize", this.draw);
    this.pending = "";
    try {
      input.setRawMode!(this.wasRaw);
    } finally {
      try {
        if (!this.wasFlowing) input.pause();
      } finally {
        this.output.write(leave);
      }
    }
  }
}
