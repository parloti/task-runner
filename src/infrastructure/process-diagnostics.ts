import type { ChildProcess } from "node:child_process";

import type { CommandDiagnostics } from "../domain";

import { monitorHostResources } from "./host-resources";

export class ProcessDiagnostics {
  private child: ChildProcess | undefined;
  private details: Omit<CommandDiagnostics, "host">;
  private readonly finishResources = monitorHostResources();

  constructor(logPath?: string) {
    this.details = {
      startedAt: new Date().toISOString(),
      ...(logPath !== undefined && { logPath }),
    };
  }

  /**
   * Stop resource sampling and return the collected evidence.
   * @returns Observed process lifecycle and bounded host resource context.
   * @example `onDiagnostics(diagnostics.finish())` delivers terminal evidence.
   */
  finish(): CommandDiagnostics {
    return { ...this.details, host: this.finishResources() };
  }

  /**
   * Observe the owned process without interpreting its output.
   * @param child Process created for the command.
   * @example `diagnostics.observe(child)` records exit and stream-close evidence.
   */
  observe(child: ChildProcess): void {
    this.child = child;
    if (child.pid !== undefined)
      this.details = { ...this.details, pid: child.pid };
    child.once("exit", (code, signal) => {
      this.details = {
        ...this.details,
        exitedAt: new Date().toISOString(),
        ...(code !== null && { exitCode: code }),
        ...(signal != undefined && { signal }),
      };
    });
    child.once("close", (code, signal) => {
      this.details = {
        ...this.details,
        closedAt: new Date().toISOString(),
        ...(code !== null && { exitCode: code }),
        ...(signal != undefined && { signal }),
      };
    });
  }

  /**
   * Preserve an operating-system error code without replacing the original error.
   * @param error Failure observed while executing or cleaning up the process.
   * @example `diagnostics.recordError(error)` preserves ENOENT on a failed spawn.
   */
  recordError(error: unknown): void {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
    )
      this.details = { ...this.details, errorCode: error.code };
  }

  /**
   * Record a runner termination request only while the process is still active.
   * @param reason Whether cancellation or error cleanup initiated termination.
   * @example `diagnostics.requestTermination("cancellation")` records runner ownership.
   */
  requestTermination(reason: "cancellation" | "cleanup"): void {
    const child = this.child;
    if (
      child?.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      this.details.closedAt !== undefined ||
      this.details.exitedAt !== undefined ||
      this.details.terminationRequested !== undefined
    )
      return;
    this.details = {
      ...this.details,
      terminationRequested: { reason, timestamp: new Date().toISOString() },
    };
  }
}
