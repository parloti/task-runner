import type { TaskEvent, TaskId } from "../domain";

/**
 * Update start and completion times for groups that display task descendants.
 * @param event Scheduler state change being applied.
 * @param descendants Command and group tasks owned by each displayed group.
 * @param started First activity timestamps keyed by task ID.
 * @param durations Frozen durations for terminal groups.
 * @param now Timestamp used for this state change.
 * @example `updateGroupTiming(event, descendants, started, durations)` records group activity.
 */
export function updateGroupTiming(
  event: TaskEvent,
  descendants: ReadonlyMap<TaskId, ReadonlySet<TaskId>>,
  started: Map<TaskId, number>,
  durations: Map<TaskId, number>,
  now = Date.now(),
): void {
  if (event.status === "running") {
    started.set(event.taskId, now);
    for (const [group, tasks] of descendants) {
      if (tasks.has(event.taskId) && !started.has(group))
        started.set(group, now);
    }
  }
  if (
    descendants.has(event.taskId) &&
    !["pending", "ready", "running"].includes(event.status)
  ) {
    durations.set(event.taskId, now - (started.get(event.taskId) ?? now));
  }
}
