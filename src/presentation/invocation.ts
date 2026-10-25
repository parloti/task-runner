const quote = (argument: string): string =>
  /^[\w./:@=+-]+$/.test(argument) ? argument : JSON.stringify(argument);

export function formatInvocation(
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const script = environment["npm_lifecycle_script"];
  const event = environment["npm_lifecycle_event"];
  if (environment["npm_command"] === "run-script" && script && event) {
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
        .map(quote)
        .join(" ");
    }
  }
  return ["task-runner", ...args].map(quote).join(" ");
}
