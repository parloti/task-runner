# Specification

## Scope

- Standalone CLI and reusable library for executing task graphs explicitly
  declared in version-2 JSON.
- An optional typed config constructor that formats caller-supplied task
  definitions as runner JSON.
- No package discovery, tool inference, workflow selection, watch daemon, remote
  execution, or plugin framework.

## Execution contract

- Input: version-2 JSON config, task name, package scope, CI/concurrency and
  keep-going options, cache bypass, and optional cancellation signal. The config declares every package path,
  task, dependency, and npm script reference the runner may execute.
- The optional root `defaults` object can set `ci`, `concurrency`, `collapse`,
  `keepGoing`, `maxTasks`, `noCache`, and `scroll`. Explicit CLI values take precedence over
  configured defaults; omitted values use built-in defaults. A non-empty `CI`
  environment variable continues to enable CI behavior. CI bypasses cache
  reads and defaults to fail-fast execution; an explicit keep-going run option
  can override fail-fast. Configured or CLI concurrency can override CI's
  sequential concurrency default. Concurrency accepts a positive integer or
  `"auto"`.
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
- The runner does not discover packages, inspect package manifests, or decide which
  scripts, tasks, or task groups belong to a project. It executes only commands
  declared in the config.
- Preflight validates the complete configuration, references, cycles, and
  concurrency settings before command side effects. It does not check
  whether configured npm scripts exist.
- Required npm scripts are attempted by npm and fail as task execution when
  absent. Optional npm tasks pass `--if-present` and succeed when the script is
  absent.
- Selected prerequisites must succeed before dependents start.
- Each task identity executes once per run. Independent tasks can overlap up to
  the global leaf-command limit; dependency waits do not consume slots.
- Local runs default to `auto`; CI runs default to one command when concurrency
  is omitted. Explicit CLI/config values, including `"auto"`, override the CI
  limit. Numeric concurrency remains a fixed positive integer limit.
- Auto concurrency starts at one command and is capped by the effective CPU
  count. The scheduler samples resources once per second, raises the limit by
  one after two samples with CPU at or below 70% and memory headroom at or above
  25%. CPU above the growth threshold pauses ramp-up; the scheduler lowers the
  limit by one when memory headroom is 15% or lower. It never cancels active
  commands to meet a lower limit.
- Auto mode uses Linux cgroup v1/v2 CPU quota and CPU-set limits and available
  memory when detected; otherwise it uses host metrics. If resource sampling is
  unavailable at startup, it falls back to the previous half-CPU default.
- Outside CI, independent selected tasks continue after a command fails by
  default. CI defaults to fail-fast. Dependents of failed tasks become blocked;
  active independent tasks are cancelled in fail-fast mode, and their
  subprocess/stream cleanup is awaited. Failure context is preserved.
- `--keep-going` and library option `keepGoing: true` opt into continuing
  independent tasks in CI. Outside CI, `defaults.keepGoing`, `--keep-going`,
  and library option `keepGoing: true` enable continuing; this is the default.
  Set `defaults.keepGoing: false`, pass `--no-keep-going`, or use library option
  `keepGoing: false` to stop admission and cancel active work after a failure.
  Explicit CLI/library values take precedence over defaults.
- Command tasks whose final state is `failed` are saved as candidates for the
  next runner invocation. The record is scoped to the selected config file.
  Still-configured candidates already present in the requested graph receive
  scheduler priority. Candidates outside that graph are not added, so an
  invocation runs only its requested task plan. Canceled, blocked, and removed
  tasks are not retried. Cached groups containing a candidate are bypassed so it
  executes. Each completed run replaces the saved candidates, so a run with no
  failed tasks clears them. Overlapping runs retain the candidates from the
  latest completed run.
- Library callers receive task states and errors without process-global changes.
  CLI exit codes are 0 for success, 1 for failure, 130 for interrupt, and 143
  for termination.

## Persistent task cache

- Tasks opt in with `cache.inputs`, a non-empty list of config-root-relative
  file patterns. Optional `exclude` patterns narrow inputs; `outputs` declares
  artifacts that must still match; `env` names relevant environment variables.
  The runner hashes declared files as opaque content, including manifests or
  lockfiles when the caller lists them. It never infers scripts or dependencies.
  Pattern matching includes hidden files and directories.
- A successful command or group can be reused across invocations when its
  input file names and contents, declared environment, Node version, platform,
  architecture, selected member definitions, and output contents match.
  Adding or deleting an input invalidates the entry. Every declared output
  pattern must match at least one file. Missing or modified outputs force a run.
- Cached groups reuse their selected members, including shared tasks, without
  starting commands. Dependency ordering still applies. Uncached tasks continue
  to execute normally. Only deterministic tasks with declared inputs and
  exclusively owned outputs should opt in; external state is not inferred.
- Successful checkpoints survive later task failures or cancellation. Failed,
  blocked, and cancelled tasks are never recorded. Inputs changed during a run
  prevent recording a new successful entry.
- Cache records live in `.cache/task-runner` independently of invocation logs.
  Writes replace individual records atomically; overlapping invocations cannot
  publish partial records. Records contain fingerprints, not source or
  environment contents. Cache read, validation, and write errors fail visibly.
  Symbolic-link inputs are rejected rather than silently ignoring their targets.
- The latest run's failed command IDs are also stored in `.cache/task-runner`,
  independently of invocation logs and cache fingerprints, scoped to the
  selected config file. Overlapping runs preserve completion order. Runs with no
  failed tasks replace this list with an empty list.
- CI mode, `defaults.noCache: true`, `--no-cache`, or library option
  `noCache: true` bypasses all cache reads and executes the complete selected
  plan. Successful execution refreshes entries.
  This does not select tasks outside that plan and cannot affect direct npm calls.
- Progress and JSONL events distinguish `cached` from newly `succeeded` tasks,
  retain the reused success timestamp, and explain cache misses. Artifacts are
  verified in place, not restored from an archive. No remote cache is used.

## Diagnostics

- Scheduler events identify task, package, status, and terminal duration/error.
- Terminal events for started commands include structured process diagnostics:
  the owned process ID when available, start/exit/stream-close timestamps,
  observed exit code or signal, process error code, relative output-log path,
  and whether the runner requested termination for cancellation or cleanup.
  Exit and stream closure are separate observations; wrappers can hide failures
  in their descendants. A nonzero exit or signal alone never establishes an
  assertion failure, external kill, resource exhaustion, or retry safety.
- Cancelled events identify external cancellation, executor cancellation, or
  the task whose failure triggered fail-fast cancellation. Expected cancellation
  remains free of error diagnostics.
- Command diagnostics sample host-wide CPU utilization and free physical memory
  at startup, every second while the command is active, and at completion.
  They retain at most 10 recent samples, sample count, peak sampled CPU
  utilization, minimum sampled free memory, and total physical memory.
  CPU utilization is calculated between samples across all logical CPUs.
  These measurements concern the entire host, not a task or its descendants,
  and indicate correlation, never a proven failure cause. Sampling failures
  are recorded explicitly without replacing the command outcome.
- JSONL events include runner PID, Node version, platform, architecture, and
  the current effective concurrency limit. Auto-mode limits can change during
  the run. Error messages remain readable strings; an additional
  bounded structured error includes names, codes, causes, and aggregate errors.
  Diagnostics never parse command output, infer tools, inspect report formats,
  or collect environment values, command arguments, or process memory dumps.
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
  and task labels. Pending, ready, running, waiting, succeeded, failed, blocked,
  and cancelled states remain distinguishable. A started group shows `running`
  while a command in its displayed subtree is running, and `waiting` when no
  such command is running. This derived group state does not change scheduler
  events or command-only status counts.
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
  later phases. Group total duration (`⧗`) measures wall-clock time from that
  first start to the group's terminal event. Group real duration (`∑`) sums the
  durations of its command tasks, using nested groups' real durations. Both
  update live and freeze on completion, blocking, or cancellation; groups with
  no started work report zero. Collapse and viewport limits do not affect this.
- Live status icons use color and a dot spinner; labels and state words remain
  readable without color. `NO_COLOR` or `FORCE_COLOR=0` disables status colors.
- CI mode, enabled by a non-empty `CI`, `--ci`, or `defaults.ci`, streams
  command stdout and stderr directly to the invoking console, bypasses cached
  results, and emits no runner task progress or final task summary. Failure
  diagnostics remain visible. Full state transitions remain in the JSONL event
  log.
- Redirected output and dumb terminals use non-animated progress without
  ready-state noise. Full state transitions remain in the JSONL event log.
- Terminal animation stops before CLI diagnostics and on every completion path.
- Outside CI mode, after a run returns the CLI prints a persistent command-only
  task-status summary after any failure/log diagnostics, on success, failure, or cancellation.
  It uses the live footer's counts, excludes groups and zero-count statuses,
  includes the runner completion timestamp in ISO 8601 UTC format, and is also
  present in plain output. Preflight or runner exceptions do not print a
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
- Task identity reuse is run-local; explicitly configured successful results
  also support the persistent cache described above.
- Published as `@codeperfect/task-runner`; the package exposes the `task-runner`
  bin from the compiled distribution and excludes pack archives.
