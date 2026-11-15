import type { CompiledTask, TaskEvent, TaskId, TaskStatus } from "../domain";

export type CacheLookup =
  | { readonly completedAt: string; readonly hit: true }
  | { readonly hit: false; readonly reason: string };

export interface ExecutionCache {
  lookup(
    task: CompiledTask,
    members: readonly CompiledTask[],
  ): Promise<CacheLookup>;
  store(
    task: CompiledTask,
    members: readonly CompiledTask[],
    completedAt: string,
  ): Promise<string | undefined>;
}

/**
 * Look up outer groups first so a full cache hit needs only one snapshot.
 * @param graph Selected, validated task graph.
 * @param cache Successful-result persistence adapter.
 * @param onEvent Observer for cache-miss diagnostics.
 * @param forceRunTasks Task IDs that must execute rather than use cached results.
 * @returns Reusable task identities with their prior success timestamps.
 * @example `prepareCachedTasks(graph, cache)` checks groups before individual commands.
 */
export async function prepareCachedTasks(
  graph: ReadonlyMap<TaskId, CompiledTask>,
  cache: ExecutionCache,
  onEvent?: (event: TaskEvent) => void,
  forceRunTasks: ReadonlySet<TaskId> = new Set<TaskId>(),
): Promise<ReadonlyMap<TaskId, string>> {
  const cached = new Map<TaskId, string>();
  const scopes = graph
    .values()
    .filter((task) => task.cache !== undefined)
    .map((task) => ({ members: membersOf(task, graph), task }))
    .toArray()
    .toSorted((left, right) => right.members.length - left.members.length);
  for (const { members, task } of scopes) {
    if (cached.has(task.id)) continue;
    if (members.some((member) => forceRunTasks.has(member.id))) {
      onEvent?.({
        cacheReason: "retry-priority",
        package: task.package,
        status: "pending",
        taskId: task.id,
      });
      continue;
    }
    const result = await cache.lookup(task, members);
    if (result.hit) {
      for (const member of members) cached.set(member.id, result.completedAt);
    } else {
      onEvent?.({
        cacheReason: result.reason,
        package: task.package,
        status: "pending",
        taskId: task.id,
      });
    }
  }
  return cached;
}

/**
 * Persist only completed checkpoints after all owned commands have settled.
 * @param graph Selected, validated task graph.
 * @param cache Successful-result persistence adapter.
 * @param states Final scheduler states.
 * @param completedAt Timestamps of newly completed tasks.
 * @param onEvent Observer for skipped cache writes.
 * @example `storeSuccessfulTasks(graph, cache, states, timestamps)` preserves completed checkpoints.
 */
export async function storeSuccessfulTasks(
  graph: ReadonlyMap<TaskId, CompiledTask>,
  cache: ExecutionCache,
  states: ReadonlyMap<TaskId, TaskStatus>,
  completedAt: ReadonlyMap<TaskId, string>,
  onEvent?: (event: TaskEvent) => void,
): Promise<void> {
  for (const task of graph.values()) {
    const timestamp = completedAt.get(task.id);
    if (
      timestamp === undefined ||
      task.cache === undefined ||
      states.get(task.id) !== "succeeded"
    )
      continue;
    const reason = await cache.store(task, membersOf(task, graph), timestamp);
    if (reason !== undefined)
      onEvent?.({
        cacheReason: reason,
        completedAt: timestamp,
        package: task.package,
        status: "succeeded",
        taskId: task.id,
      });
  }
}

/**
 * Select cache scope with the same command boundary as graph selection.
 * @param task Command or group whose result is cached.
 * @param graph Selected graph containing the cache scope.
 * @returns The task and its recursively selected group members.
 * @example `membersOf(testTask, graph)` includes only the test command.
 */
function membersOf(
  task: CompiledTask,
  graph: ReadonlyMap<TaskId, CompiledTask>,
): readonly CompiledTask[] {
  const members = new Map<TaskId, CompiledTask>();
  const visit = (member: CompiledTask): void => {
    if (members.has(member.id)) return;
    members.set(member.id, member);
    if (member.run === undefined)
      for (const id of member.dependsOn) {
        const dependency = graph.get(id);
        if (dependency === undefined)
          throw new Error(`Missing cache dependency: ${id}`);
        visit(dependency);
      }
  };
  visit(task);
  return members.values().toArray();
}
