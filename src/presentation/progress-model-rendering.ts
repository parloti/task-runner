import { stripVTControlCharacters } from "node:util";

import type { CompiledTask, TaskStatus } from "../domain";

import { taskName } from "../domain";

/** Color preference supplied by the live terminal renderer. */
export interface LiveAppearance {
  readonly color: boolean;
}

/** Mutable display row retained while a progress graph changes state. */
export interface ProgressRow {
  readonly children: ProgressRow[];
  readonly depth: number;
  hidden: boolean;
  readonly scope: string;
  readonly task: CompiledTask;
}

export const markers: Record<Exclude<TaskStatus, "running">, string> = {
  blocked: "!",
  cancelled: "~",
  failed: "x",
  pending: ".",
  ready: ">",
  skipped: "-",
  succeeded: "+",
};

export const liveMarkers: Record<Exclude<TaskStatus, "running">, string> = {
  blocked: "\u{26A0}",
  cancelled: "\u{25A0}",
  failed: "\u{2716}",
  pending: "\u{25A1}",
  ready: "\u{203A}",
  skipped: "\u{2193}",
  succeeded: "\u{2714}",
};

export const colors = {
  blocked: "yellow",
  cancelled: "magenta",
  failed: "red",
  pending: "gray",
  ready: "yellow",
  running: "cyan",
  skipped: "gray",
  succeeded: "green",
} as const satisfies Record<TaskStatus, string>;

export const spinner =
  "\u{280B}\u{2819}\u{2839}\u{2838}\u{283C}\u{2834}\u{2826}\u{2827}\u{2807}\u{280F}";

const safeText = (value: string): string =>
  stripVTControlCharacters(value).replaceAll(/[\p{Cc}\p{Cf}]/gu, " ");

/**
 * Format a task label using the current package display scope.
 * @param task Task to label.
 * @param scope Package path whose prefix may be omitted.
 * @returns A terminal-safe readable label.
 * @example `taskLabel(task, "apps/web")` omits that package prefix.
 */
export function taskLabel(task: CompiledTask, scope: string): string {
  const name = taskName(task);
  return safeText(
    task.package === "." || task.package === scope
      ? name
      : `${task.package} > ${name}`,
  );
}
