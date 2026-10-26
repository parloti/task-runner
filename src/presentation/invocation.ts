const quote = (argument: string): string =>
  /^[\w./:@=+-]+$/.test(argument) ? argument : JSON.stringify(argument);

/**
 * Format the command invocation shown above task progress.
 * @param args Arguments passed to the task-runner process.
 * @param environment Process environment containing npm lifecycle details.
 * @returns A readable shell command for the invocation.
 * @example `formatInvocation(["run", "build"], process.env)` formats the active command.
 */
export function formatInvocation(
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const script = environment["npm_lifecycle_script"];
  const event = environment["npm_lifecycle_event"];
  if (script && event && environment["npm_command"] === "run-script") {
    const prefix = script.trim().split(/\s+/);
    const invocation = ["task-runner", ...args];
    if (
      prefix[0] === "task-runner" &&
      prefix.every((argument, index) => argument === invocation[index])
    ) {
      const forwarded = invocation.slice(prefix.length);
      return [
        "npm",
        "run",
        event,
        ...(forwarded.length > 0 ? ["--", ...forwarded] : []),
      ]
        .map((argument) => quote(argument))
        .join(" ");
    }
  }
  return ["task-runner", ...args].map((argument) => quote(argument)).join(" ");
}
