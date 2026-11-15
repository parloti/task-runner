# Architecture

| Component            | Ownership                                                                                                | Dependencies                          |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `src/domain`         | Task/config/event contracts, graph compilation, readable task names, and optional preset construction    | `ts-brand`                            |
| `src/application`    | Scheduler, executor/cache ports, cache-scope selection, and run options                                  | Domain                                |
| `src/infrastructure` | Config parsing, processes, npm CLI discovery, file fingerprints, atomic records, and cross-process locks | Application, domain, and Node         |
| `src/presentation`   | CLI arguments, nested progress view, terminal redraw                                                     | Application, domain, Node, log-update |
| `src/bootstrap`      | Runtime composition, logging, signals, executable                                                        | All layers                            |
| `tests/e2e`          | Real subprocess and consumer behavior                                                                    | Public/runtime boundaries             |

- Version-2 package-local JSON is validated at the IO boundary, including
  optional runner defaults. Bootstrap combines configured defaults with explicit
  CLI values before presentation starts; runtime defaults are also applied by
  the library runner, including cache bypass. Graph compilation resolves
  local and qualified references into one graph with canonical readable IDs
  (root names or
  `<package>#<task>`). No serialized arrays or entrypoint map.
- The runner reads the explicit config and does not inspect package manifests.
  npm command execution is delegated to the configured npm CLI invocation,
  including `--if-present` for optional tasks.
- Graph task IDs become nominal `TaskId` values after reference validation.
- Graph selection recursively expands commandless groups but stops at commands.
  After selection, command dependencies are retained only when their targets
  are selected. Groups explicitly list their members; aliases use the same rule.
- A single scheduler admits ready leaf commands and owns cancellation/state.
- The validated plan can include prior failed command targets alongside the
  requested entrypoint. The scheduler gives those targets and their selected
  prerequisites queue priority without creating a second execution path.
- Caller-declared `CacheDefinition` values survive config parsing, preset
  construction, and graph compilation. Application cache planning checks outer
  groups first and marks selected members reusable without changing task
  selection or dependency ordering. `cached` is a successful terminal state
  distinct from new execution. Completed checkpoints are persisted after owned
  commands settle; cache failures remain unsuccessful and retain command errors.
- Infrastructure hashes explicit input/output files and named environment
  values; no manifest interpretation or dependency discovery is involved.
  `.cache/task-runner` contains atomic successful-result records independently
  of transient logs. Bootstrap injects this adapter, and `noCache` bypasses reads
  while refreshing successful results. No artifact archive or remote cache exists.
- Infrastructure stores failed task IDs from the latest completed run in a
  config-scoped record under `.cache/task-runner`; locked, timestamp-ordered
  updates keep overlapping runs from replacing newer results. Bootstrap adds
  still-configured command IDs to the next plan, and application scheduling
  prioritizes them with their selected prerequisites.
  Globby performs dot-inclusive discovery behind the fingerprint adapter.
- Process adapters implement npm/shell execution, tree termination, and streams.
- Domain execution errors distinguish expected command failure/cancellation.
  The CLI prints concise command failures; cancellation retains status without
  error diagnostics. Infrastructure owns safe timestamp/task/PID log paths;
  bootstrap clears stale logs only when no other invocation is active and keeps
  UUID-correlated event streams separate in the shared log folder.
- `qualifiedTaskName` derives a unique package suffix from configured package
  paths and falls back to the full path on collisions. Bootstrap supplies those
  paths to the process adapter and CLI progress display; event identities and
  log paths retain full package paths.
- CLI progress and library subscribers receive the same scheduler events.
- `onPlan` delivers the selected validated graph before execution; `onEvent`
  delivers state transitions. The presentation-only view deduplicates shared
  tasks and groups prerequisites without interpreting shell commands. Prior
  failed tasks outside the requested target appear as top-level rows in that
  same plan.
- Presentation tracks group wall-clock durations from the first activity in
  their owned display subtree and freezes them at terminal events. Shared work
  displayed elsewhere does not activate a waiting group.
  Scheduler events and command execution timing remain unchanged.
- `log-update` redraws interactive stderr with terminal wrapping/resize support.
  Presentation owns the animation timer, not task promises or cancellation.
  Live redraw is viewport-limited; final persistence uses the configured task
  cap without terminal-height clipping.
  Plain output is used for CI, non-TTY, and dumb terminals.
- Opt-in `ScrollView` owns alternate-screen drawing, wrapped viewport lines,
  keyboard/SGR mouse input, and terminal restoration. Bootstrap wires raw-mode
  Ctrl+C to the existing cancellation handler; scheduling stays unchanged.
- Node's `styleText` colors live status icons; presentation applies color opt-outs
  and leaves scheduler events, labels, and plain output unstyled.
- Listr2 is not a dependency; rendering never introduces a second scheduler.
- The optional config constructor accepts complete task definitions from its
  caller and returns schema-compatible version-2 JSON. It does not create
  repository-specific scripts, task groups, or package inventories.
- Preset construction lives in `src/domain/presets.ts` and depends only on
  domain config types, so it follows the existing domain boundary.
- The package exports compiled JavaScript, declarations, optional presets, and
  a JSON schema. Production consumers do not resolve TypeScript source.
- ESLint enforces inward imports for domain/application; preset construction
  lives within the domain boundary and follows its dependency rule.
