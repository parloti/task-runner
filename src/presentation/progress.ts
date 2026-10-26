import { createLogUpdate } from "log-update";

import type { CompiledTask, TaskEvent, TaskId } from "../domain";

import { renderPersistentFrame } from "./progress-listing";
import { ProgressModel } from "./progress-model";
import { type ScrollOptions, ScrollView } from "./scroll-view";

interface ProgressOutput extends NodeJS.WritableStream {
  readonly rows?: number;
}

export class TerminalProgress {
  private frame = 0;
  private model: ProgressModel | undefined;
  private redraw: ReturnType<typeof createLogUpdate> | undefined;
  private scrollView: ScrollView | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

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
    if (this.scroll === undefined) {
      this.redraw = createLogUpdate(this.output, { showCursor: true });
    } else {
      this.scrollView = new ScrollView(this.output, this.scroll);
      this.scrollView.start();
    }
    this.render();
    this.timer = setInterval(() => {
      this.render();
    }, 80);
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

  summary(): string {
    if (this.model === undefined) throw new Error("Progress has not started");
    return this.model.summary();
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

  private fullFrame(): string {
    return renderPersistentFrame(
      this.getModel(),
      this.frame++,
      this.maxTasks,
      process.env["NO_COLOR"] === undefined &&
        process.env["FORCE_COLOR"] !== "0",
    );
  }

  private getModel(): ProgressModel {
    if (this.model === undefined) throw new Error("Progress has not started");
    return this.model;
  }

  private getRedraw(): ReturnType<typeof createLogUpdate> {
    if (this.redraw === undefined)
      throw new Error("Interactive progress has not started");
    return this.redraw;
  }

  private render(): void {
    if (this.scrollView !== undefined) {
      this.scrollView.render(this.fullFrame(), this.getModel().summary());
      return;
    }
    const taskLimit = Math.max(1, (this.output.rows ?? 24) - 2);
    const visibleTaskLimit = Math.min(this.maxTasks, taskLimit);
    this.getRedraw()(
      this.getModel().frame(this.frame++, visibleTaskLimit, {
        color:
          process.env["NO_COLOR"] === undefined &&
          process.env["FORCE_COLOR"] !== "0",
      }),
    );
  }
}
