import type { Brand } from "ts-brand";

export interface CacheDefinition {
  readonly env?: readonly string[];
  readonly exclude?: readonly string[];
  readonly inputs: readonly string[];
  readonly outputs?: readonly string[];
}

export type Command =
  | {
      readonly args?: readonly string[];
      readonly kind: "npm";
      readonly optional?: boolean;
      readonly script: string;
    }
  | { readonly command: string; readonly kind: "shell" };

export interface CompiledTask {
  readonly cache?: CacheDefinition;
  readonly dependsOn: readonly TaskId[];
  readonly id: TaskId;
  readonly package: string;
  readonly run?: Command;
}

export type ExecuteCommand = (
  task: CompiledTask,
  signal: AbortSignal,
) => Promise<void>;

export interface RunnerConfig {
  readonly $comment?: string;
  readonly defaults?: RunnerDefaults;
  readonly packages: Readonly<
    Record<string, Readonly<Record<string, TaskDefinition>>>
  >;
  readonly version: 2;
}

export interface RunnerDefaults {
  readonly ci?: boolean;
  readonly collapse?: boolean;
  readonly concurrency?: number;
  readonly maxTasks?: number;
  readonly scroll?: boolean;
}

export interface RunResult {
  readonly errors: readonly unknown[];
  readonly states: ReadonlyMap<TaskId, TaskStatus>;
  readonly success: boolean;
}

export interface TaskDefinition {
  readonly cache?: CacheDefinition;
  readonly dependsOn?: readonly string[];
  readonly run?: Command;
}

export interface TaskEvent {
  readonly cacheReason?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly error?: Error;
  readonly package: string;
  readonly status: TaskStatus;
  readonly taskId: TaskId;
}

export type TaskId = Brand<string, "task-runner/TaskId">;

export type TaskStatus =
  | "blocked"
  | "cached"
  | "cancelled"
  | "failed"
  | "pending"
  | "ready"
  | "running"
  | "succeeded";
