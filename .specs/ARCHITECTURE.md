# Architecture

| Component            | Ownership                                              | Dependencies                          |
| -------------------- | ------------------------------------------------------ | ------------------------------------- |
| `src/domain`         | Task/config/event contracts and pure graph compilation | `ts-brand`                            |
| `src/application`    | Scheduler, executor port, and run options              | Domain                                |
| `src/infrastructure` | Config/manifests, processes, npm discovery             | Domain and Node                       |
| `src/presentation`   | CLI arguments, nested progress view, terminal redraw   | Application, domain, Node, log-update |
| `src/bootstrap`      | Runtime composition, logging, signals, executable      | All layers                            |
| `src/presets`        | Optional pure workflow construction                    | Domain contracts                      |
| `tests/e2e`          | Real subprocess and consumer behavior                  | Public/runtime boundaries             |

- Version-2 package-local JSON is validated at the IO boundary. Graph compilation
  resolves local/qualified references into one graph with canonical readable IDs
  (root names or `<package>#<task>`). No serialized arrays or entrypoint map.
- Graph task IDs become nominal `TaskId` values after reference validation.
- A single scheduler admits ready leaf commands and owns cancellation/state.
- Process adapters implement npm/shell execution, tree termination, and streams.
- Domain execution errors distinguish expected command failure/cancellation.
  The CLI prints concise command failures; cancellation retains status without
  error diagnostics. Infrastructure owns safe PID/task/timestamp log paths;
  bootstrap keeps UUID-correlated event streams separate within each PID folder.
- CLI progress and library subscribers receive the same scheduler events.
- `onPlan` delivers the selected validated graph before execution; `onEvent`
  delivers state transitions. The presentation-only view deduplicates shared
  tasks and groups prerequisites without interpreting shell commands.
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
- Presets expose root `validate:<workspace>` groups for monorepo validation,
  reusing shared task identities and build-gated checks without workspace lint.
- The package exports compiled JavaScript, declarations, optional presets, and
  a JSON schema. Production consumers do not resolve TypeScript source.
- ESLint enforces inward imports for domain/application/presets.
