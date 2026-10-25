import { parseArgs } from "node:util";

import type { RunOptions } from "../application/run-options.js";

export function parseArguments(args: string[]): {
  entrypoint: string;
  options: RunOptions & {
    readonly collapse?: boolean;
    readonly maxTasks?: number;
    readonly scroll: boolean;
  };
  help: boolean;
} {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      package: { type: "string" },
      ci: { type: "boolean" },
      concurrency: { type: "string" },
      collapse: { type: "string" },
      "max-tasks": { type: "string" },
      scroll: { type: "boolean", default: true },
      "no-scroll": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const names = positionals[0] === "run" ? positionals.slice(1) : positionals;
  if (!values.help && (names.length !== 1 || !names[0]))
    throw new Error(
      "Usage: task-runner run <entrypoint> [--config path] [--package path] [--ci] [--concurrency n] [--collapse true|false] [--max-tasks n] [--no-scroll]",
    );
  const concurrency =
    values.concurrency === undefined ? undefined : Number(values.concurrency);
  if (
    concurrency !== undefined &&
    (!Number.isSafeInteger(concurrency) || concurrency < 1)
  )
    throw new Error("Concurrency must be a positive integer");
  if (
    values.collapse !== undefined &&
    values.collapse !== "true" &&
    values.collapse !== "false"
  )
    throw new Error("Collapse must be true or false");
  const maxTasks =
    values["max-tasks"] === undefined ? undefined : Number(values["max-tasks"]);
  if (
    maxTasks !== undefined &&
    (!Number.isSafeInteger(maxTasks) || maxTasks < 1)
  )
    throw new Error("Max tasks must be a positive integer");
  const scroll = values["no-scroll"] !== true && values.scroll === true;
  return {
    entrypoint: names[0] ?? "",
    help: values.help === true,
    options: {
      ...(values.config === undefined ? {} : { config: values.config }),
      ...(values.package === undefined ? {} : { package: values.package }),
      ...(values.ci === undefined ? {} : { ci: values.ci }),
      ...(concurrency === undefined ? {} : { concurrency }),
      ...(values.collapse === undefined
        ? {}
        : { collapse: values.collapse === "true" }),
      ...(maxTasks === undefined ? {} : { maxTasks }),
      scroll,
    },
  };
}
