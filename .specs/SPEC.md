# Specification

## Scope

- Standalone CLI and reusable library for executing task graphs explicitly
  declared in version-2 JSON.
- An optional typed config constructor that formats caller-supplied task
  definitions as runner JSON.
- No package discovery, tool inference, workflow selection, automatic retries,
  caching, watch daemon, remote execution, or plugin framework.

## Execution contract

- Input: version-2 JSON config, task name, package scope, CI/concurrency options,
  and optional cancellation signal. The config declares every package path,
  task, dependency, and npm script reference the runner may execute.
- The optional root `defaults` object can set `ci`, `concurrency`, `collapse`,
  `maxTasks`, and `scroll`. Explicit CLI values take precedence over configured
  defaults; omitted values use built-in defaults. A non-empty `CI` environment
  variable continues to enable CI behavior. Configured or CLI concurrency can
  override CI's sequential concurrency default.
- Tasks live in `packages[path][name]`, without task-level package fields
  or entrypoint mappings. Any local task is directly invocable. Bare dependency
  names resolve locally; `<package-path>#<task>` selects another package and
  `.#<task>` explicitly selects the root. `#` is reserved in paths and names.
  Commandless tasks represent groups and aliases; their `dependsOn` lists select
  members recursively, stopping at commands. A command's `dependsOn` only orders
  tasks already selected; it never adds earlier commands or groups to the run.
  Direct commands start at themselves. Mutation groups and workspace aliases
  run only their selected mutation tasks, without tests or builds; dependencies
  between selected mutation tasks still apply. A `test:all` group explicitly
  selecting both `test` and `mutation` runs them in dependency order.
  Version 1 is unsupported.
  Generated configuration omits empty dependency lists.
- Package paths are config-relative; invocation selects the nearest containing
  configured package, including when called from a nested directory.
- Tasks explicitly declare task dependencies and an optional npm/shell command.
  A task with no command completes after its prerequisites.
- The runner does not discover packages, read `package.json`, or decide which
  scripts, tasks, or task groups belong to a project. It executes only commands
  declared in the config.
- Preflight validates the complete configuration, references, cycles, and
  positive integer concurrency before command side effects. It does not check
  whether configured npm scripts exist.
- Required npm scripts are attempted by npm and fail as task execution when
  absent. Optional npm tasks pass `--if-present` and succeed when the script is
  absent.
- Selected prerequisites must succeed before dependents start.
- Each task identity executes once per run. Independent tasks can overlap up to
  the global leaf-command limit; dependency waits do not consume slots.
- Default concurrency is `max(1, floor(availableParallelism() / 2))`.
  A non-empty CI variable, `--ci`, or `defaults.ci` defaults to one active
  command and streamed output. An explicit positive integer concurrency from
  the CLI or `defaults` overrides either default.
- A command failure stops admission, blocks dependent work, cancels active work,
  and awaits owned subprocess/stream cleanup. Failure context is preserved.
- Library callers receive task states and errors without process-global changes.
  CLI exit codes are 0 for success, 1 for failure, 130 for interrupt, and 143
  for termination.

## Diagnostics

- Scheduler events identify task, package, status, and terminal duration/error.
- Command logs use
  `logs/task-runner/<timestamp>-<full-task-name>-<pid>.log`. Full names include
  workspace and readable task names, with filesystem-safe normalization and
  bounded length. ISO timestamps are filename-safe and monotonically unique
  within the process, including concurrent invocations.
- Successful and cancelled command logs are removed after streams close and
  owned-process cleanup finishes. Failures retain both output streams.
  Expected command failures print readable names and relative log paths, without
  runner stacks. Cancellation adds no error diagnostic or command log; task
  statuses remain in the progress tree and event stream. Unexpected IO, spawn,
  and cleanup errors remain visible, including during cancellation.
  CI keeps its existing streamed output behavior without command-output files.
- Each invocation clears `logs/task-runner` before execution when no other
  invocation is active. Active invocations register before releasing the
  startup lock; overlapping invocations share the folder and never clear one
  another's logs. A later non-overlapping invocation clears retained files.
- UUID-correlated `events-<run-id>.jsonl` files in the same folder isolate
  invocation event streams, including invocations sharing a PID.
- Interactive terminals show a nested, animated task list with readable package
  and task labels. Pending, ready, running, succeeded, failed, blocked, and
  cancelled states remain distinguishable.
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
- Cross-workspace command labels use `<package-suffix>:<task>` when the suffix
  is unique, such as `automation:mutation`; ambiguous suffixes use the full
  package path. Tasks within the current package context omit that qualifier.
  Failure and cancellation messages use the same labels; event data and log
  paths retain the full package path.
- Pending and successful groups collapse in live output by default. Groups
  expand when their displayed subtree starts; nested pending groups remain
  collapsed. Failed, blocked, and cancelled groups remain expanded.
  `defaults.collapse` and `--collapse true|false` set this behavior, with CLI
  values taking precedence.
  Failure messages retain log paths.
- `--max-tasks N` accepts a positive safe integer and defaults to 100 task rows
  unless `defaults.maxTasks` is set, excluding the omitted-count summary. Live
  output fits the terminal viewport;
  final output persists up to the configured limit in scrollback. With collapse
  disabled, terminal height never removes completed descendants from that
  final listing, including after failure or cancellation. Interactive final
  listings retain a blank line above and below the task tree to separate it
  from the invocation and subsequent diagnostics or shell prompt.
- The alternate-screen live viewport is enabled by default unless
  `defaults.scroll` is set; `--no-scroll` disables it and `--scroll` enables it,
  taking precedence over the configured default. Up/Down move one
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
  includes the runner completion timestamp in ISO 8601 UTC format, and is also
  present in plain/CI output. Preflight or runner exceptions do not print a
  completed-run summary.
- External telemetry can subscribe through the event contract; a backend is not
  required to execute local commands.

## Config constructor

- The optional `createWorkspacePreset` function accepts caller-supplied package
  task definitions and optional runner defaults, then returns a version-2
  `RunnerConfig` compatible with `task-runner.json`.
- It may make convenience-only shape transformations, such as omitting empty
  dependency lists. It does not inspect a repository, generate npm scripts,
  infer package metadata, or choose tasks and task groups.
- The caller owns deciding which package paths, scripts, commands, and
  dependencies to include. The runner executes only the configuration it is
  given.

## Operational limits

- Node.js >=24. npm must be discoverable through its CLI script.
- Shell tasks use the host shell; npm tasks use argument arrays.
- Windows owned-tree cancellation is forced; POSIX allows a bounded graceful
  shutdown before escalation. No unrelated process is a cancellation target.
- Package and task identity reuse is run-local, not a persistent build cache.
- Published as `@codeperfect/task-runner`; the package exposes the `task-runner`
  bin from the compiled distribution and excludes pack archives.
