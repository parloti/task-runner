import type { CompiledTask, TaskEvent, TaskId } from "../domain/types.js";

export interface RunOptions {
  readonly cwd?: string;
  readonly config?: string;
  readonly package?: string;
  readonly ci?: boolean;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: TaskEvent) => void;
  readonly onPlan?: (
    graph: ReadonlyMap<TaskId, CompiledTask>,
    target: string,
  ) => void;
}
