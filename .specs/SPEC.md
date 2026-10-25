# Specification

## Scope

- Standalone CLI and reusable library for explicit task DAGs and npm scripts.
- Optional metadata-driven build, pack, lint, test, and validation presets.
- No caching, watch daemon, remote execution, plugin framework, tool inference,
  automatic retries, registry publication, or Workspaces Manager dependency.

## Execution contract

- Input: version-2 JSON config, task name, package scope, CI/concurrency options,
  and optional cancellation signal.
- Tasks live in `packages[path][name]`, without task-level package fields
  or entrypoint mappings. Any local task is directly invocable. Bare dependency
  names resolve locally; `<package-path>#<task>` selects another package and
  `.#<task>` explicitly selects the root. `#` is reserved in paths and names.
  Commandless tasks represent groups and aliases. Version 1 is unsupported.
  Generated configuration omits empty dependency lists.
- Package paths are config-relative; invocation selects the nearest containing
  configured package, including when called from a nested directory.
- Tasks explicitly declare task dependencies and an optional npm/shell command.
  A task with no command completes after its prerequisites.
- Preflight validates the complete configuration, declared manifests/scripts,
  references, cycles, and positive integer concurrency before command side effects.
- Required scripts fail when absent/empty; explicitly optional scripts skip.
- Prerequisites must succeed or explicitly skip before dependents start.
- Each task identity executes once per run. Independent tasks can overlap up to
  the global leaf-command limit; dependency waits do not consume slots.
- Default concurrency is `max(1, availableParallelism() - 1)`.
  A non-empty CI variable or `--ci` defaults to one active command and streamed
  output. An explicit positive integer concurrency overrides either default.
- A command failure stops admission, blocks dependent work, cancels active work,
  and awaits owned subprocess/stream cleanup. Failure context is preserved.
- Library callers receive task states and errors without process-global changes.
  CLI exit codes are 0 for success, 1 for failure, 130 for interrupt, and 143
  for termination.

## Diagnostics

- Scheduler events identify task, package, status, and terminal duration/error.
- Command logs use `logs/task-runner/<pid>/<full-task-name>-<timestamp>.log`.
  Full names include workspace and readable task names, with filesystem-safe
  normalization and bounded length. ISO timestamps are filename-safe and
  monotonically unique within the process, including concurrent invocations.
- Successful and cancelled command logs are removed after streams close and
  owned-process cleanup finishes. Failures retain both output streams.
  Expected command failures print readable names and relative log paths, without
  runner stacks. Cancellation adds no error diagnostic or command log; task
  statuses remain in the progress tree and event stream. Unexpected IO, spawn,
  and cleanup errors remain visible, including during cancellation.
  CI keeps its existing streamed output behavior without command-output files.
- UUID-correlated `events-<run-id>.jsonl` files isolate invocations sharing a PID.
- No invocation clears another invocation's logs.
- Interactive terminals show a nested, animated task list with readable package
  and task labels. Pending, ready, running, succeeded, failed, skipped, blocked,
  and cancelled states remain distinguishable.
- Display nesting comes from the validated graph, not npm-command parsing.
  Groups contain their prerequisites; command prerequisites appear in execution
  order within the containing group. Shared workspace tasks appear once under
  their matching reachable validation group, otherwise under their first
  containing group. Empty cross-package aggregate wrappers are omitted.
  Display ownership never controls execution.
- Every group establishes package context for its subtasks; matching
  `validate:<workspace>` groups establish the named workspace context.
  Cross-package groups retain their prefix at the boundary, but their children
  omit it. Siblings retain their own parent's context at every nesting depth.
- Pending and successful groups collapse in live output by default. Groups
  expand when their displayed subtree starts; nested pending groups remain
  collapsed. Failed, blocked, and cancelled groups remain expanded.
  `--collapse false`
  keeps completed subtasks visible; `--collapse true` enables collapsing.
  Failure messages retain log paths.
- `--max-tasks N` accepts a positive safe integer and defaults to 100 task rows,
  excluding the omitted-count summary. Live output fits the terminal viewport;
  final output persists up to the configured limit in scrollback. With collapse
  disabled, terminal height never removes completed descendants from that
  final listing, including after failure or cancellation. Interactive final
  listings retain a blank line above and below the task tree to separate it
  from the invocation and subsequent diagnostics or shell prompt.
- The alternate-screen live viewport is enabled by default; `--no-scroll`
  disables it. `--scroll` remains accepted. Up/Down move one
  rendered line; Page Up/Down move one page; Home/End select the boundaries.
  SGR mouse-wheel reports move three lines where supported by the terminal.
  The viewport wraps long rows, clamps scrolling on resize/collapse, and respects
  `--max-tasks` and `--collapse`. Ctrl+C retains normal cancellation semantics.
  Completion, cancellation, and setup/runtime failures restore raw input,
  cursor visibility, mouse reporting, and the normal screen before final output.
  Scrolling activates only with TTY stdin; CI/non-TTY/dumb output ignores it.
- The scroll view pins the invocation above tasks and the navigation footer
  below them; neither is included in the final tree. npm run-script wrappers
  use the lifecycle script name and forwarded arguments; other invocations
  show `task-runner` and its arguments. Original shell spelling/quoting is not
  available. The header wraps on narrow terminals and is bounded to leave one
  task row and the footer. A blank row separates the header from tasks and tasks
  from the two-line footer. The first footer line counts unique command tasks
  by scheduler status, including collapsed and off-screen tasks. Commandless
  groups are excluded from every count; their spinners indicate subtree
  activity, not occupied concurrency slots. Zero-count statuses are omitted.
  The second retains line range/navigation.
  Tiny terminals omit the header, then spacing/counts as needed to retain a
  task row; footer lines are clipped to width. All chrome is transient.
- Groups stay pending until work in their displayed subtree starts. Shared
  prerequisites displayed under another group do not start waiting groups or
  later phases. Group durations measure wall-clock time from that first start
  to the group's terminal event, without summing overlapping commands. They
  update live and freeze on completion, blocking, or cancellation; groups with
  no started work report zero. Collapse and viewport limits do not affect this.
- Live status icons use color and a dot spinner; labels and state words remain
  readable without color. `NO_COLOR` or `FORCE_COLOR=0` disables status colors.
- CI, redirected output, and dumb terminals use non-animated progress without
  ready-state noise. Full state transitions remain in the JSONL event log.
- Terminal animation stops before CLI diagnostics and on every completion path.
- After a run returns, the CLI prints a persistent command-only task-status
  summary after any failure/log diagnostics, on success, failure, or cancellation.
  It uses the live footer's counts, excludes groups and zero-count statuses,
  and is also present in plain/CI output. Preflight or runner exceptions do not
  print a completed-run summary.
- External telemetry can subscribe through the event contract; a backend is not
  required to execute local commands.

## Presets

- Inputs are explicit package descriptors and internal package dependencies.
  Callers own filesystem discovery and dependency-field selection.
- Build orders clean, compile, and path resolution; internal dependencies build
  before consumers. Package pack is an ordinary npm command depending on build,
  without a separate pack:artifact task. Root monorepo pack aggregates packages.
- Documentation depends on the package build. Root monorepo documentation waits
  for the aggregate workspace build, including when invoked directly.
- Root lint runs once. Root validation omits duplicate workspace lint and gates
  workspace typechecks/tests on builds. Root typecheck waits for all builds.
- Monorepo validation groups workspace checks under `validate:<workspace>`
  alongside root lint. Root docs follow those groups in the display; shared
  prerequisite execution and global concurrency are unchanged.
- Local validation retains local lint and package-local behavior.
- Angular, extension, utility, browser/Playwright, and style descriptors control
  applicable commands; absent inapplicable tasks are not required.
- Root aliases use unique workspace suffixes; duplicate names/paths/suffixes fail.

## Operational limits

- Node.js >=24. npm must be discoverable through its CLI script.
- Shell tasks use the host shell; npm tasks use argument arrays.
- Windows owned-tree cancellation is forced; POSIX allows a bounded graceful
  shutdown before escalation. No unrelated process is a cancellation target.
- Package and task identity reuse is run-local, not a persistent build cache.
- Local tarball dependencies are not portable registry releases.
