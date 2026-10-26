import type { Brand } from "ts-brand";

export type Command =
  | {
      readonly args?: readonly string[];
      readonly kind: "npm";
      readonly optional?: boolean;
      readonly script: string;
    }
  | { readonly command: string; readonly kind: "shell" };

export interface CompiledTask {
  readonly dependsOn: readonly TaskId[];
  readonly id: TaskId;
  readonly package: string;
  readonly run?: Command;
  readonly skip: boolean;
}

export type ExecuteCommand = (
  task: CompiledTask,
  signal: AbortSignal,
) => Promise<void>;

export interface RunnerConfig {
  readonly $comment?: string;
  readonly packages: Readonly<
    Record<string, Readonly<Record<string, TaskDefinition>>>
  >;
  readonly version: 2;
}

export interface RunResult {
  readonly errors: readonly unknown[];
  readonly states: ReadonlyMap<TaskId, TaskStatus>;
  readonly success: boolean;
}

export interface TaskDefinition {
  readonly dependsOn?: readonly string[];
  readonly run?: Command;
}

export interface TaskEvent {
  readonly durationMs?: number;
  readonly error?: Error;
  readonly package: string;
  readonly status: TaskStatus;
  readonly taskId: TaskId;
}

export type TaskId = Brand<string, "task-runner/TaskId">;

export type TaskStatus =
  | "blocked"
  | "cancelled"
  | "failed"
  | "pending"
  | "ready"
  | "running"
  | "skipped"
  | "succeeded";
