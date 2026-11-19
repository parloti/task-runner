import type { TaskId } from "./types";

export interface CancellationDetails {
  readonly kind: "executor" | "external" | "task-failed";
  readonly reason?: string;
  readonly taskId?: TaskId;
}

export interface CommandDiagnostics {
  readonly closedAt?: string;
  readonly errorCode?: string;
  readonly exitCode?: number;
  readonly exitedAt?: string;
  readonly host: HostResourceUsage;
  readonly logPath?: string;
  readonly pid?: number;
  readonly signal?: string;
  readonly startedAt: string;
  readonly terminationRequested?: {
    readonly reason: "cancellation" | "cleanup";
    readonly timestamp: string;
  };
}

export interface HostResourceSample {
  readonly cpuPercent?: number;
  readonly freeMemoryBytes: number;
  readonly timestamp: string;
}

export interface HostResourceUsage {
  readonly error?: string;
  readonly minFreeMemoryBytes?: number;
  readonly peakCpuPercent?: number;
  readonly sampleCount: number;
  readonly sampleIntervalMs: number;
  readonly samples: readonly HostResourceSample[];
  readonly totalMemoryBytes?: number;
}
