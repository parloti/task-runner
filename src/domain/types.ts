import type { Brand } from "ts-brand";

export type TaskId = Brand<string, "task-runner/TaskId">;

export type Command =
  | {
      readonly kind: "npm";
      readonly script: string;
      readonly args?: readonly string[];
      readonly optional?: boolean;
    }
  | { readonly kind: "shell"; readonly command: string };

export interface TaskDefinition {
  readonly dependsOn?: readonly string[];
  readonly run?: Command;
}

export interface RunnerConfig {
  readonly version: 2;
  readonly packages: Readonly<
    Record<string, Readonly<Record<string, TaskDefinition>>>
  >;
}

export interface CompiledTask {
  readonly id: TaskId;
  readonly package: string;
  readonly dependsOn: readonly TaskId[];
  readonly run?: Command;
  readonly skip: boolean;
}

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "blocked"
  | "cancelled";

export interface TaskEvent {
  readonly taskId: TaskId;
  readonly package: string;
  readonly status: TaskStatus;
  readonly durationMs?: number;
  readonly error?: Error;
}

export interface RunResult {
  readonly success: boolean;
  readonly states: ReadonlyMap<TaskId, TaskStatus>;
  readonly errors: readonly unknown[];
}

export type ExecuteCommand = (
  task: CompiledTask,
  signal: AbortSignal,
) => Promise<void>;
