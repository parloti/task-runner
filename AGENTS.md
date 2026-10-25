# Task Runner

- Node.js >=24; TypeScript ESM. Compiled CLI and declarations ship in `dist`.
- Graph policy belongs in `src/domain`; scheduling and ports in
  `src/application`; IO and processes in `src/infrastructure`; CLI parsing in
  `src/presentation`; composition in `src/bootstrap`.
- `src/presets` is an optional pure module. It accepts explicit package
  descriptors; never import Workspaces Manager or infer tools from disk here.
- Use version-2 package-local task definitions and readable local/qualified
  references, never serialized array identities or a separate entrypoint map.
  Omit empty dependencies; keep package pack as a direct npm command.
- One scheduler owns execution. Renderers consume events and never schedule
  commands or re-resolve prerequisites.
- Keep nested terminal progress presentation-only; use the validated plan for
  hierarchy and scheduler events for state. CI/non-TTY output must not animate.
- Concurrency and footer status counts concern command tasks only, never
  commandless groups. Group spinners/timers start only with their displayed
  subtree, not shared prerequisites owned by another group.
- Live progress uses colored status icons; respect `NO_COLOR` and `FORCE_COLOR=0`
  and keep plain output free of ANSI styling.
- Validate the complete graph before command side effects. Cancel only owned
  process trees, await cleanup, and preserve original errors and failed logs.
- `npm test` runs tests. `npm run validate` is the full gate. Releases publish
  `@codeperfect/task-runner` through semantic-release on `main`; never publish
  manually. Keep the `task-runner` bin and keep pack archives out of `files`.
- Current contracts: [.specs/SPEC.md](.specs/SPEC.md).
- Current structure: [.specs/ARCHITECTURE.md](.specs/ARCHITECTURE.md).
