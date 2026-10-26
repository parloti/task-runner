/** Error raised when an operating-system signal stops the CLI run. */
export class CliSignalError extends Error {
  /**
   * Create a signal error with its corresponding process exit code.
   * @param exitCode Exit code for the received termination signal.
   * @param message Readable description of the signal.
   * @example `new CliSignalError(130, "Interrupted")` records Ctrl+C.
   */
  constructor(
    readonly exitCode: 130 | 143,
    message: string,
  ) {
    super(message);
    this.name = "CliSignalError";
  }
}

/**
 * Select the CLI exit code from task success or a handled signal.
 * @param success Whether all selected tasks completed successfully.
 * @param reason Abort reason supplied by a CLI signal handler.
 * @returns Zero for success, a signal code, or one for other failures.
 * @example `cliExitCode(false, reason)` returns 130 after Ctrl+C.
 */
export function cliExitCode(success: boolean, reason: unknown): number {
  if (success) return 0;
  return reason instanceof CliSignalError ? reason.exitCode : 1;
}
