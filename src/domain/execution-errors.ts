export class CommandFailedError extends Error {
  constructor(
    task: string,
    code: null | number,
    readonly logPath?: string,
  ) {
    super(
      `Command failed (${String(code)}): ${task}${logPath === undefined ? "" : `\nLog: ${logPath}`}`,
    );
  }
}

export class TaskCancelledError extends Error {
  constructor(task: string) {
    super(`Cancelled task: ${task}`);
  }
}

/**
 * Convert a process boundary rejection to an Error while keeping its cause.
 * @param value Unknown rejection reason supplied by an executor.
 * @returns The original Error or a wrapper Error with the rejection as cause.
 * @example `normalizeExecutionError("closed")` keeps the value in `cause`.
 */
export function normalizeExecutionError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error(String(value), { cause: value });
}
