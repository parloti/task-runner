import type { TaskEvent, TaskId, TaskStatus } from "../domain";
import type { ProgressRow } from "./progress-model-rendering";

/** State required to derive group status and timing for the progress model. */
export interface ProgressRowState {
  readonly commandDurations: ReadonlyMap<TaskId, number>;
  readonly commandTasks: ReadonlySet<TaskId>;
  readonly events: ReadonlyMap<TaskId, TaskEvent>;
  readonly groupChildren: ReadonlyMap<TaskId, ReadonlySet<TaskId>>;
  readonly groupDescendants: ReadonlyMap<TaskId, ReadonlySet<TaskId>>;
  readonly groupDurations: ReadonlyMap<TaskId, number>;
  readonly groupRealDurations: ReadonlyMap<TaskId, number>;
  readonly packagePaths: readonly string[];
  readonly started: ReadonlyMap<TaskId, number>;
}

export type ProgressStatus = "waiting" | TaskStatus;

/**
 * Sum direct command durations and nested group real durations.
 * @param group Group whose displayed work is being measured.
 * @param now Timestamp used for currently running commands.
 * @param state Current scheduler events and presentation timing state.
 * @returns Active or frozen real duration for the displayed group subtree.
 * @example `groupRealDuration(group, Date.now(), state)` sums selected work.
 */
export function groupRealDuration(
  group: TaskId,
  now: number,
  state: ProgressRowState,
): number {
  const frozen = state.groupRealDurations.get(group);
  if (frozen !== undefined) return frozen;
  let duration = 0;
  const children = state.groupChildren.get(group) ?? [];
  for (const task of children) {
    if (state.commandTasks.has(task)) {
      const completed = state.commandDurations.get(task);
      if (completed !== undefined) {
        duration += completed;
      } else if (state.events.get(task)?.status === "running") {
        duration += Math.max(0, now - (state.started.get(task) ?? now));
      }
    } else {
      duration += groupRealDuration(task, now, state);
    }
  }
  return duration;
}

/**
 * Derive the progress-only status for a displayed row.
 * @param row Row whose presentation state is being rendered.
 * @param state Current scheduler events and presentation timing state.
 * @returns Scheduler state or the derived waiting state for a started group.
 * @example `progressStatus(groupRow, state)` returns `waiting` between commands.
 */
export function progressStatus(
  row: ProgressRow,
  state: ProgressRowState,
): ProgressStatus {
  const status = state.events.get(row.task.id)?.status ?? "pending";
  if (
    row.task.run === undefined &&
    state.started.has(row.task.id) &&
    (status === "pending" || status === "running")
  ) {
    const descendants = state.groupDescendants.get(row.task.id) ?? [];
    const runningCommand = [...descendants].some(
      (task) =>
        state.commandTasks.has(task) &&
        state.events.get(task)?.status === "running",
    );
    return runningCommand ? "running" : "waiting";
  }
  return status;
}
