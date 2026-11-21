# Task Runner

A dependency-aware task runner with a compiled CLI and reusable library.
Requires Node.js 24 or newer. No consumer-specific integration or runtime
TypeScript loader is required.
Local development preparation installs a source CLI shim; packed consumers use
the compiled executable without running that development-only setup.

## Install

Install the CLI and library as a development dependency:

```bash
npm install --save-dev @codeperfect/task-runner
```

The package provides the `task-runner` command, a TypeScript library, workspace
presets, and a JSON schema.

## Validation

- `npm test` runs source-level unit tests.
- `npm run build` produces the compiled distribution.
- `npm run docs` generates HTML API documentation for the package and presets
  under `docs/api/`.
- `npm run e2e` tests runtime behavior and isolated consumers. Packaging tests
  build a temporary copy and skip packing/install lifecycle scripts, so they
  do not depend on the repository's `dist` during concurrent validation.
- `npm run validate` runs the complete workflow with independent tasks in
  parallel.
- `npm run validate -- --concurrency 1` runs the complete workflow serially,
  including build before E2E.

## Configuration

Put `task-runner.json` at the repository root:

```json
{
  "version": 2,
  "defaults": {
    "concurrency": 3,
    "collapse": false,
    "maxTasks": 150,
    "scroll": false
  },
  "packages": {
    ".": {
      "compile": { "run": { "kind": "npm", "script": "compile" } },
      "test": {
        "dependsOn": ["compile"],
        "run": { "kind": "npm", "script": "test" }
      },
      "docs": { "run": { "kind": "npm", "script": "docs", "optional": true } },
      "check": { "dependsOn": ["compile", "test", "docs"] }
    }
  }
}
```

The config is the complete workflow declaration: it lists configured package
paths, task names, dependencies, and npm script references. The runner does not
discover workspace packages or decide which scripts and task groups belong in
the project. The project-maintenance tool or project owner that writes this file
owns those decisions.

The optional `defaults` object sets runner behavior when the corresponding CLI
option is omitted. It accepts `ci`, `concurrency`, `collapse`, `keepGoing`,
`maxTasks`, `noCache`, and `scroll`. An explicit CLI option takes precedence
over its configured default; otherwise built-in defaults apply. The `CI`
environment variable still enables CI behavior, and an explicitly configured
concurrency can override its sequential concurrency default.

Independent selected tasks continue after a command fails by default. Tasks
that depend on a failed task are blocked. Set `"keepGoing": false` under
`defaults` or pass `--no-keep-going` to stop admitting tasks and cancel active
work after the first failure. `--keep-going` explicitly enables the default
behavior.

Concurrency accepts a positive integer for a fixed limit or `"auto"` for
resource-aware scheduling. Local runs use `auto` when no concurrency is set;
CI runs default to one command unless `auto` or a number is explicitly set.
For example, use `"concurrency": "auto"` in `defaults` or run
`task-runner run check --concurrency auto` to enable adaptive scheduling in CI.
Library callers can use `runTasks("check", { concurrency: "auto" })`.

Keep `compile` and `test` as ordinary npm scripts; add
`"check": "task-runner run check"` to `package.json`. Task references are explicit,
not inferred from shell text. Use `{ "kind": "shell", "command": "..." }` for an
intentional platform-specific shell command. npm tasks accept an `args` array,
forwarded after `npm run <script> --`, and preserve npm lifecycle hooks.

```powershell
npm run check
npm run check -- --ci
npm run check -- --concurrency 3
npm run check -- --collapse false
npm run check -- --collapse false --max-tasks 150
npm run check -- --no-scroll --collapse false --max-tasks 1000
npm run check -- --no-cache
npm run check -- --keep-going
npm run check -- --no-keep-going
```

Package keys are relative paths using `/`, or `.` for the root. Each package
maps local task names directly to definitions; there is no `tasks` wrapper or
entrypoint mapping. A bare
dependency such as `compile` refers to the same package. Use
`packages/lib#build` for another package or `.#build` for the root.
The `#` separator is reserved in package paths and task names.
Commandless tasks provide groups and aliases; any task is directly invocable.
Invoking a command starts at that command without pulling in earlier steps.
Groups recursively select the members listed in their `dependsOn`, stopping at
commands. Command dependencies only order tasks already selected.
For example, `task-runner run mutation` and `task-runner run mutation:back`
skip `test`, including through workspace groups and aliases. Dependencies
between selected mutation tasks are still respected. A `test:all` group that
explicitly lists both `test` and `mutation` runs `test` first.
Groups must list every intended command: a build pipeline lists `clean`,
`compile`, and `resolve-paths`, not just its final step.
Generated configuration omits empty dependency lists. Version 1 is not supported.
Invoking from a workspace selects that package's task without accidentally
selecting a root aggregate. Nested
directories select their nearest containing configured package.
`--config <path>` and `--package <relative-path>` override discovery/selection.
Settings such as `--concurrency`, `--ci`, `--collapse`, `--keep-going`,
`--max-tasks`, and `--scroll` override matching values in `defaults`.
The schema is exported as `@codeperfect/task-runner/schema.json`.

### Persistent successful-result cache

Opt deterministic commands or groups into caching with explicit file inputs:

```json
{
  "cache": {
    "inputs": [
      "src/**/*",
      "package.json",
      "package-lock.json",
      "tsconfig*.json"
    ],
    "exclude": ["src/generated/**"],
    "env": ["NODE_ENV", "NODE_OPTIONS"]
  },
  "run": { "kind": "npm", "script": "test" }
}
```

Patterns are relative to the configuration root, including for workspace tasks.
Include all relevant configuration, dependency sources, and environment names;
the runner does not infer them. Groups can also declare `outputs`, such as
`["packages/lib/dist/**/*"]`, to require intact artifacts before skipping their
selected commands. Every output pattern must match a file.

Successful results persist in `.cache/task-runner` (add `.cache/` to `.gitignore`).
Content changes, added/deleted inputs, command changes, relevant environment or
Node/platform changes, and missing/modified outputs invalidate entries.
Progress shows `cached` and the prior success time; JSONL events explain misses.
Completed checks remain reusable if another task fails. Artifacts are verified
in place, not restored; external side effects must not be cached.

`defaults.noCache: true`, `--no-cache`, or `runTasks("check", { noCache: true })`
runs the complete selected plan and refreshes successful records. Direct npm
calls bypass the runner and remain unaffected. Cache IO or malformed-record
failures are reported; bypass can repair malformed entries through successful
execution.

### Previous-run failed tasks

The runner saves task IDs that ended with `failed` in the latest completed run.
The record is scoped to the selected config file. On the next runner invocation,
still-configured command tasks from that list are added to the requested plan
with scheduler priority. Canceled, blocked, and removed tasks are skipped.
Cached groups containing a candidate are bypassed so it executes. Every
completed run replaces the list, so a run with no failed tasks clears it. When
invocations overlap, the latest completed run's list wins. This state is stored
in `.cache/task-runner` beside the successful-result cache.

## Library and presets

```typescript
import { runTasks } from "@codeperfect/task-runner";
import { createWorkspacePreset } from "@codeperfect/task-runner/presets";

const preset = createWorkspacePreset({
  packages: {
    ".": {
      compile: { run: { kind: "npm", script: "compile" } },
      check: { dependsOn: ["compile"] },
    },
  },
});

const result = await runTasks("check", {
  cwd: "/path/to/repository",
  signal: abortController.signal,
  onEvent: (event) => console.log(event.status, event.taskId),
});
// Write preset to task-runner.json; npm scripts remain in package.json.
```

`createWorkspacePreset` is a convenience-only config constructor. It accepts
the complete task definitions chosen by the caller and returns a version-2
object compatible with `task-runner.json`; it does not inspect the project or
decide which packages, scripts, or task groups to include. When a task
references an npm script, that script's command remains in the configured
package's `package.json`; the config names the script the runner should execute.

`compileGraph` and `executeGraph` also support an injected command executor for
non-process integrations. Library calls return results or propagate boundary
errors; they never set process exit status or install global signal handlers.

## Runtime behavior

- Validate the configuration, task references, and cycles before execution.
- The runner does not interpret `package.json`. Declared cache inputs can hash
  its contents without inspecting scripts. Required npm scripts are attempted
  through npm and fail as task execution if missing; an optional npm script
  adds `--if-present` and succeeds when absent.
- Execute shared tasks once per invocation, with one global leaf-command limit.
- Local runs default to adaptive concurrency. The scheduler starts with one
  command slot, samples CPU and memory once per second, and adds one slot after
  two healthy samples (CPU at or below 70% and memory headroom at or above
  25%). CPU above the growth threshold pauses ramp-up. The runner removes one
  slot when memory headroom is 15% or lower. Active commands finish normally
  when the limit decreases. Auto mode is capped by available CPUs, including
  Linux cgroup v1/v2 quota and CPU-set limits where detectable. Memory headroom
  uses cgroup limits when available and host memory otherwise. If startup
  resource sampling is unavailable, the runner falls back to half the available
  CPUs, rounded down, with a minimum of one.
- `defaults.concurrency` or `--concurrency N` sets a fixed positive integer
  limit; `"auto"` selects adaptive scheduling. Non-empty `CI`, `defaults.ci`,
  or `--ci` defaults to one command and streams output. An explicit CLI or
  config concurrency setting takes precedence, including `auto` in CI.
- By default, independent selected tasks continue after a command failure;
  dependents of failed tasks remain blocked, and active independent processes
  finish normally. Set `defaults.keepGoing: false`, pass `--no-keep-going`, or
  call `runTasks` with `keepGoing: false` to stop admission and cancel active
  processes after a failure. `--keep-going` and `keepGoing: true` explicitly
  select the default behavior.
  Windows cancellation terminates the owned tree; POSIX cancellation escalates
  from SIGTERM to SIGKILL.
- Interactive terminals show nested groups with animated running tasks,
  durations, readable package labels, and distinct waiting/ready/success/failure/
  blocked/cancelled states. Unstarted and successful groups collapse by
  default; groups expand when their subtree starts, while nested unstarted
  groups remain collapsed. Failed, blocked, and cancelled groups stay expanded;
  `defaults.collapse` or `--collapse true|false` sets the collapse behavior;
  explicit CLI values win. This option does not affect execution or plain CI
  output.
- Groups stay pending until work in their displayed subtree starts. Shared
  dependencies displayed elsewhere do not activate waiting workspaces or later
  phases such as pack and test:all. Group timers start with their subtree's first
  work and stop when the group finishes, without summing overlapping durations.
- Live status icons are colored: cyan running spinner, green success, red
  failure, yellow ready/blocked, magenta cancelled, and gray pending.
  Set `NO_COLOR` or `FORCE_COLOR=0` to disable colors without losing state icons.
- Shared prerequisites appear once. Workspace tasks belong to their matching
  validation group when it is included; otherwise their first containing group
  owns the display. Empty cross-package aggregate wrappers are omitted.
  Display ownership never changes execution order or concurrency.
- `defaults.maxTasks` or `--max-tasks N` sets the interactive task-row cap to a
  positive integer, default 100, excluding the omitted-task summary. Live
  redraw fits the terminal viewport;
  the final listing is preserved in scrollback up to the configured cap.
  `--collapse false` retains completed children in the final listing after
  success, failure, or cancellation, regardless of terminal height.
- CI, redirected output, and `TERM=dumb` use concise non-animated progress.
  Full transitions remain in JSONL. Animation stops before final diagnostics.
  Rendering uses `log-update`, not Listr2 or a second task scheduler.
- Scrolling is enabled by default. `defaults.scroll`, `--no-scroll`, or
  `--scroll` sets the alternate-screen live view, with explicit CLI values
  taking precedence. Use Up/Down, Page Up/Down, Home/End, or the mouse wheel
  where SGR mouse reporting is supported (such as compatible Git Bash terminals).
  A pinned header shows the command; the footer shows the visible line range.
  Both disappear when the view closes. npm scripts show `npm run <script>`
  with forwarded arguments; direct calls show `task-runner` and its arguments.
  Shell quoting is reconstructed, not recovered from shell history.
  Blank rows separate tasks from the header and footer. The two-line footer
  shows task counts by status, then the line range/navigation controls.
  Counts include only unique command tasks throughout the plan, regardless of
  collapse, scrolling, or the display limit; groups are excluded and zero-count
  statuses are omitted. Running counts reflect the global command limit, not
  group spinners, which indicate started work in their displayed subtree.
  Long headers wrap, bounded to leave task space; tiny terminals omit the
  header, spacing, or counts as needed. Ctrl+C cancels the run normally.
  On completion or failure the normal screen/input modes are restored and the
  final tree is printed into scrollback, with a blank line above and below it.
  Terminal scrollbars/Shift+wheel are not
  the live viewport controls. Scrolling activates only with TTY stdin; CI,
  redirected output, and dumb terminals retain plain output.
- Logs use `logs/task-runner/<pid>/<workspace-task>-<timestamp>.log`, with
  filename-safe names and timestamps. Successful/cancelled output logs are
  removed after cleanup. Failed commands print a readable task name and relative
  log path without runner stacks; cancellation adds no error diagnostic.
  Unexpected runner/cleanup failures still surface normally.
  After success, failure, or cancellation, a persistent task-status summary
  follows any failure/log messages, including in plain/CI output. It uses the
  same command-only counts as the live footer and ends with the completion
  timestamp in ISO 8601 UTC format (`| Finished at: <timestamp>`).
  Structured events remain in separate `events-<run-id>.jsonl` files per invocation.
  Command output may contain sensitive tool output; treat retained logs accordingly.

### Diagnosing command failures

Terminal JSONL events and library `onEvent` callbacks include `command`
diagnostics for started commands: PID, observed exit code/signal, separate
process-exit and output-close timestamps, log path, and runner-requested
termination. Cancelled events include `cancellation.kind` and the initiating
`taskId` when another task failed. JSONL also preserves runner context and
structured `errorDetails`, including error codes, causes, and cleanup failures;
the existing `error` field remains a readable message.

`command.host` samples host-wide CPU utilization and free physical memory
every second, with at most 10 recent samples and lifetime pressure peaks.
Sampling errors appear in `command.host.error`. These are host measurements,
not per-task or process-tree measurements. High CPU usage, low memory, a signal,
or a nonzero exit is evidence, not proof of why a command failed.
An npm or shell wrapper can hide the exit details of its descendants.
The runner does not identify tools, parse output, or distinguish assertions
from tool crashes when both produce the same exit code.

Custom `ExecuteCommand` implementations may use the optional third callback
to provide `CommandDiagnostics` before settling; existing two-argument
executors continue to work.

See the [behavior specification](https://github.com/parloti/task-runner/blob/main/.specs/SPEC.md)
and [architecture guide](https://github.com/parloti/task-runner/blob/main/.specs/ARCHITECTURE.md).
For local setup and pull request guidance, see
[CONTRIBUTING.md](https://github.com/parloti/task-runner/blob/main/CONTRIBUTING.md).
