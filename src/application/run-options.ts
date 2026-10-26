import type { CompiledTask, TaskEvent, TaskId } from "../domain";

export interface RunOptions {
  readonly ci?: boolean;
  readonly concurrency?: number;
  readonly config?: string;
  readonly cwd?: string;
  readonly onEvent?: (event: TaskEvent) => void;
  readonly onPlan?: (
    graph: ReadonlyMap<TaskId, CompiledTask>,
    target: string,
  ) => void;
  readonly package?: string;
  readonly signal?: AbortSignal;
}
