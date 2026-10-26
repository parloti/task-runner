import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";

/**
 * Creates a child process mock that closes successfully unless the command fails.
 * @param file Executable passed to spawn.
 * @param args Arguments passed to spawn.
 * @param _options Spawn options, unused by the mock.
 * @param pid Optional process ID to expose on the child.
 * @returns A child process mock with closed output streams.
 * @example
 * ```ts
 * mockSpawn("node", [], {});
 * ```
 */
export function mockSpawn(
  file: Parameters<typeof spawn>[0],
  args: Parameters<typeof spawn>[1],
  _options: Parameters<typeof spawn>[2],
  pid?: number,
): ChildProcess {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const properties: PropertyDescriptorMap = {
    stderr: { value: stderr },
    stdout: { value: stdout },
  };
  if (pid !== undefined) properties["pid"] = { value: pid };
  Object.defineProperties(child, properties);
  const command = `${file} ${args.join(" ")}`;
  const code = command.includes("process.exitCode=2") ? 2 : 0;
  queueMicrotask(() => {
    stdout.end();
    stderr.end();
    child.emit("close", code);
  });
  return child;
}
