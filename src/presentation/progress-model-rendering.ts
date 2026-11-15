import { stripVTControlCharacters, styleText } from "node:util";

import type { CompiledTask } from "../domain";

import { qualifiedTaskName, taskName } from "../domain";
import {
  groupRealDuration,
  type ProgressRowState,
  type ProgressStatus,
  progressStatus,
} from "./progress-model-group-timing";

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

const markers: Record<Exclude<ProgressStatus, "running">, string> = {
  blocked: "!",
  cached: "=",
  cancelled: "~",
  failed: "x",
  pending: ".",
  ready: ">",
  succeeded: "+",
  waiting: "\u{2026}",
};

const liveMarkers: Record<Exclude<ProgressStatus, "running">, string> = {
  blocked: "\u{26A0}",
  cached: "=",
  cancelled: "\u{25A0}",
  failed: "\u{2716}",
  pending: "\u{25A1}",
  ready: "\u{203A}",
  succeeded: "\u{2714}",
  waiting: "\u{2026}",
};

const colors = {
  blocked: "yellow",
  cached: "blue",
  cancelled: "magenta",
  failed: "red",
  pending: "gray",
  ready: "yellow",
  running: "cyan",
  succeeded: "green",
  waiting: "yellow",
} as const satisfies Record<ProgressStatus, string>;

const spinner =
  "\u{280B}\u{2819}\u{2839}\u{2838}\u{283C}\u{2834}\u{2826}\u{2827}\u{2807}\u{280F}";

const formatDuration = (durationMs: number): string =>
  `${(durationMs / 1000).toFixed(1)}s`;

const safeText = (value: string): string =>
  stripVTControlCharacters(value).replaceAll(/[\p{Cc}\p{Cf}]/gu, " ");

/**
 * Render a row and its duration details for one progress frame.
 * @param row Display row to render.
 * @param frame Current animation frame.
 * @param appearance Optional live terminal colors and markers.
 * @param state Current scheduler events and presentation timing state.
 * @returns One readable progress line.
 * @example `renderProgressRow(row, 0, appearance, state)` formats a task row.
 */
export function renderProgressRow(
  row: ProgressRow,
  frame: number,
  appearance: LiveAppearance | undefined,
  state: ProgressRowState,
): string {
  const status = progressStatus(row, state);
  const event = state.events.get(row.task.id);
  const start = state.started.get(row.task.id);
  const now = Date.now();
  const details: string[] = [];
  if (row.task.run === undefined) {
    const totalDuration =
      state.groupDurations.get(row.task.id) ??
      (start === undefined ? undefined : now - start);
    if (totalDuration !== undefined) {
      details.push(
        `⧗ ${formatDuration(totalDuration)}`,
        `∑ ${formatDuration(groupRealDuration(row.task.id, now, state))}`,
      );
    }
  } else {
    const duration =
      event?.durationMs ?? (start === undefined ? undefined : now - start);
    if (duration !== undefined) details.push(formatDuration(duration));
  }
  let marker =
    appearance === undefined
      ? status === "running"
        ? "|/-\\".charAt(frame % 4)
        : markers[status]
      : status === "running"
        ? spinner.charAt(frame % spinner.length)
        : liveMarkers[status];
  if (appearance?.color)
    marker = styleText(colors[status], marker, { validateStream: false });
  const timestamp = event?.completedAt;
  const cacheNote =
    status === "succeeded" && event?.cacheReason !== undefined
      ? `not cached: ${event.cacheReason}`
      : "";
  if (timestamp !== undefined) details.push(`last success: ${timestamp}`);
  if (cacheNote !== "") details.push(cacheNote);
  return `${"  ".repeat(row.depth)}${marker} ${taskLabel(row.task, row.scope, state.packagePaths)}${details.length === 0 ? "" : ` (${details.join(", ")})`}`;
}

/**
 * Format a task label using the current package display scope.
 * @param task Task to label.
 * @param scope Package path whose prefix may be omitted.
 * @param packagePaths All configured package paths.
 * @returns A terminal-safe readable label.
 * @example `taskLabel(task, ".", [".", "apps/web"])` returns `web:build`.
 */
function taskLabel(
  task: CompiledTask,
  scope: string,
  packagePaths: readonly string[],
): string {
  const name = taskName(task);
  return safeText(
    task.package === scope ? name : qualifiedTaskName(task, packagePaths),
  );
}
