export class CommandFailedError extends Error {
  constructor(
    task: string,
    code: number | null,
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
