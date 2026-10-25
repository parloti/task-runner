import { createLogUpdate } from "log-update";

import type { CompiledTask, TaskEvent, TaskId } from "../domain/types.js";
import { ProgressModel } from "./progress-model.js";
import { ScrollView, type ScrollOptions } from "./scroll-view.js";

export interface ProgressOutput extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
  readonly rows?: number;
}

export class TerminalProgress {
  private model: ProgressModel | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private redraw: ReturnType<typeof createLogUpdate> | undefined;
  private frame = 0;
  private scrollView: ScrollView | undefined;

  constructor(
    private readonly output: ProgressOutput,
    private readonly interactive: boolean,
    private readonly collapse = true,
    private readonly maxTasks = 100,
    private readonly scroll?: ScrollOptions,
  ) {
    if (!Number.isSafeInteger(maxTasks) || maxTasks < 1)
      throw new Error("Max tasks must be a positive integer");
  }

  start(graph: ReadonlyMap<TaskId, CompiledTask>, target: string): void {
    if (this.model !== undefined) throw new Error("Progress already started");
    this.model = new ProgressModel(graph, target, this.collapse);
    if (!this.interactive) return;
    if (this.scroll !== undefined) {
      this.scrollView = new ScrollView(this.output, this.scroll);
      this.scrollView.start();
    } else {
      this.redraw = createLogUpdate(this.output, { showCursor: true });
    }
    this.render();
    this.timer = setInterval(() => this.render(), 80);
  }

  private render(): void {
    if (this.scrollView !== undefined) {
      this.scrollView.render(this.fullFrame(), this.model!.summary());
      return;
    }
    this.redraw!(
      this.model!.frame(
        this.frame++,
        Math.min(this.maxTasks, Math.max(1, (this.output.rows ?? 24) - 2)),
        {
          color:
            process.env["NO_COLOR"] === undefined &&
            process.env["FORCE_COLOR"] !== "0",
        },
      ),
    );
  }

  private fullFrame(): string {
    return this.model!.frame(this.frame++, this.maxTasks, {
      color:
        process.env["NO_COLOR"] === undefined &&
        process.env["FORCE_COLOR"] !== "0",
    });
  }

  update(event: TaskEvent): void {
    if (this.model === undefined) throw new Error("Progress has not started");
    this.model.update(event);
    if (this.interactive) {
      this.render();
    } else {
      const line = this.model.eventLine(event);
      if (line !== undefined) this.output.write(`${line}\n`);
    }
  }

  summary(): string {
    if (this.model === undefined) throw new Error("Progress has not started");
    return this.model.summary();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.scrollView !== undefined) {
      const view = this.scrollView;
      this.scrollView = undefined;
      try {
        view.stop();
      } finally {
        createLogUpdate(this.output, { showCursor: true }).persist(
          `\n${this.fullFrame()}\n\n`,
        );
      }
    }
    if (this.redraw !== undefined) {
      this.redraw.persist(`\n${this.fullFrame()}\n\n`);
    }
    this.redraw?.done();
    this.redraw = undefined;
  }
}
