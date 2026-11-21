import type {
  CompiledTask,
  ConcurrencySetting,
  TaskEvent,
  TaskId,
} from "../domain";

export interface RunOptions {
  readonly ci?: boolean;
  readonly concurrency?: ConcurrencySetting;
  readonly config?: string;
  readonly cwd?: string;
  /** Continue independent tasks after command failures; defaults to true. */
  readonly keepGoing?: boolean;
  readonly noCache?: boolean;
  readonly onEvent?: (event: TaskEvent) => void;
  readonly onPlan?: (
    graph: ReadonlyMap<TaskId, CompiledTask>,
    target: string,
    packagePaths: readonly string[],
  ) => void;
  readonly package?: string;
  readonly signal?: AbortSignal;
}
