import type { RunnerConfig, TaskDefinition } from "../domain";

export interface PackageDescriptor {
  readonly angular?: boolean;
  readonly browser?: boolean;
  readonly extension?: boolean;
  readonly internalDependencies?: readonly string[];
  readonly name: string;
  readonly path: string;
  readonly playwright?: boolean;
  readonly styles?: boolean;
  readonly utility?: boolean;
}

export interface WorkspacePreset {
  readonly config: RunnerConfig;
  readonly scripts: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const key = (packagePath: string, task: string): string =>
  `${packagePath}#${task}`;
const packageSuffix = (packagePath: string): string =>
  packagePath.split("/").at(-1) ?? ".";

/**
 * Construct version-2 task definitions for explicit package descriptors.
 * @param packages Root and workspace metadata supplied by the caller.
 * @returns Generated task-runner configuration and npm scripts.
 * @example `createWorkspacePreset([{ path: ".", name: "app" }])` creates root scripts.
 */
export function createWorkspacePreset(
  packages: readonly PackageDescriptor[],
): WorkspacePreset {
  const root = packages.find((pkg) => pkg.path === ".");
  if (root === undefined)
    throw new Error("Preset requires a root package at .");
  const names = new Set<string>();
  const paths = new Set<string>();
  const suffixes = new Set<string>();
  for (const pkg of packages) {
    if (
      pkg.path.includes("#") ||
      (pkg.path !== "." &&
        (pkg.path.length === 0 ||
          pkg.path.startsWith("/") ||
          pkg.path.endsWith("/") ||
          pkg.path.split("/").some((part) => part === "." || part === "..")))
    )
      throw new Error(`Invalid package path: ${pkg.path}; # is reserved`);
    const suffix = packageSuffix(pkg.path);
    if (
      names.has(pkg.name) ||
      paths.has(pkg.path) ||
      (pkg.path !== "." && suffixes.has(suffix))
    ) {
      throw new Error(
        `Duplicate package identity or script suffix: ${pkg.name} (${pkg.path})`,
      );
    }
    names.add(pkg.name);
    paths.add(pkg.path);
    if (pkg.path !== ".") suffixes.add(suffix);
  }
  const workspaces = packages.filter((pkg) => pkg.path !== ".");
  const mono = workspaces.length > 0;
  const configs: Record<string, Record<string, TaskDefinition>> = {};
  const scripts: Record<string, Record<string, string>> = {};
  for (const pkg of packages) {
    const tasks: Record<string, TaskDefinition> = {};
    configs[pkg.path] = tasks;
    const packageScripts = commands(pkg);
    const add = (
      name: string,
      dependencies: readonly string[],
      run?: TaskDefinition["run"],
    ): string => {
      tasks[name] = {
        ...(dependencies.length > 0 && { dependsOn: dependencies }),
        ...(run !== undefined && { run }),
      };
      return name;
    };
    const npm = (
      script: string,
      dependencies: readonly string[] = [],
      args?: readonly string[],
    ): string =>
      add(args === undefined ? script : `${script}:fix-command`, dependencies, {
        kind: "npm",
        script,
        ...(args !== undefined && { args }),
      });
    for (const name of Object.keys(packageScripts)) npm(name);
    const group = (name: string, dependencies: readonly string[]): string => {
      const id = add(name, dependencies);
      packageScripts[name] = `task-runner run ${name}`;
      return id;
    };
    tasks["compile"] = {
      dependsOn: ["clean"],
      run: { kind: "npm", script: "compile" },
    };
    tasks["resolve-paths"] = {
      dependsOn: ["compile"],
      run: { kind: "npm", script: "resolve-paths" },
    };
    const internalBuilds = (pkg.internalDependencies ?? []).map((name) => {
      const dependency = packages.find((candidate) => candidate.name === name);
      if (dependency === undefined || dependency.path === ".")
        throw new Error(`Unknown internal dependency: ${name}`);
      return key(dependency.path, "build");
    });
    tasks["clean"] = {
      ...(internalBuilds.length > 0 && { dependsOn: internalBuilds }),
      run: { kind: "npm", script: "clean" },
    };
    group("build", ["resolve-paths"]);
    tasks["pack"] = {
      dependsOn: ["build"],
      run: { kind: "npm", script: "pack" },
    };
    group("lint", ["prettier", "eslint", ...(pkg.styles ? ["stylelint"] : [])]);
    group("eslint:fix", [npm("eslint", ["check:rules"], ["--fix"])]);
    group("lint:fix", [
      "fmt",
      "eslint:fix",
      ...(pkg.styles ? ["stylelint:fix"] : []),
    ]);
    if (!pkg.angular) {
      tasks["mutation"] = {
        dependsOn: ["test"],
        run: { kind: "npm", script: "mutation" },
      };
    }
    group("test:all", [
      "test",
      ...(pkg.utility ? [] : ["e2e"]),
      ...(pkg.angular ? [] : ["mutation"]),
    ]);
    add("docs", ["build"], { kind: "npm", optional: true, script: "docs" });
    group("validate", [
      "build",
      "pack",
      "typecheck",
      "lint",
      "docs",
      "test:all",
    ]);
    packageScripts["validate:ci"] = "task-runner run validate --ci";
    scripts[pkg.path] = packageScripts;
  }
  if (mono) {
    const rootScripts = scripts["."];
    const tasks = configs["."];
    if (rootScripts === undefined || tasks === undefined)
      throw new Error("Root package tasks were not initialized");
    const aggregate = (name: string, dependencies: readonly string[]): void => {
      tasks[name] = {
        ...(dependencies.length > 0 && { dependsOn: dependencies }),
      };
      rootScripts[name] = `task-runner run ${name}`;
    };
    for (const name of [
      "build",
      "pack",
      "clean",
      "compile",
      "resolve-paths",
      "test",
      "tdd",
      "e2e",
      "mutation",
      "test:all",
      "eslint:fix",
      "lint:fix",
    ]) {
      const members = workspaces.filter(
        (pkg) => configs[pkg.path]?.[name] !== undefined,
      );
      aggregate(
        name,
        members.map((pkg) => key(pkg.path, name)),
      );
      for (const pkg of members) {
        const alias = `${name}:${packageSuffix(pkg.path)}`;
        tasks[alias] = { dependsOn: [key(pkg.path, name)] };
        rootScripts[alias] = `task-runner run ${
          /^[a-zA-Z0-9:._-]+$/.test(alias) ? alias : JSON.stringify(alias)
        }`;
      }
    }
    // Keep the root leaf distinct from the aggregate entrypoint.
    const rootTypecheck = rootScripts["typecheck"];
    if (rootTypecheck !== undefined)
      rootScripts["typecheck:root"] = rootTypecheck;
    tasks["typecheck:root"] = {
      dependsOn: ["build"],
      run: { kind: "npm", script: "typecheck:root" },
    };
    const rootTypechecks = workspaces.map((pkg) => {
      const packageTasks = configs[pkg.path];
      if (packageTasks === undefined)
        throw new Error(`Package tasks were not initialized: ${pkg.path}`);
      const name = "root-typecheck";
      packageTasks[name] = {
        dependsOn: [key(".", "build")],
        run: { kind: "npm", script: "typecheck" },
      };
      return key(pkg.path, name);
    });
    aggregate("typecheck", ["typecheck:root", ...rootTypechecks]);
    const gated = (name: string, pkg: PackageDescriptor): string => {
      const localTasks = configs[pkg.path];
      if (localTasks === undefined)
        throw new Error(`Package tasks were not initialized: ${pkg.path}`);
      const original = localTasks[name];
      if (original === undefined)
        throw new Error(
          `Package task was not initialized: ${pkg.path}#${name}`,
        );
      const id = `validation:${name}`;
      if (localTasks[id] !== undefined) return id;
      localTasks[id] = {
        ...original,
        dependsOn: [
          "build",
          ...(original.dependsOn ?? []).map((dependency) =>
            gated(dependency, pkg),
          ),
        ],
      };
      return id;
    };
    const validations = workspaces.map((pkg) => {
      const name = `validate:${packageSuffix(pkg.path)}`;
      aggregate(name, [
        key(pkg.path, "build"),
        key(pkg.path, "pack"),
        key(pkg.path, "docs"),
        key(pkg.path, gated("typecheck", pkg)),
        key(pkg.path, gated("test:all", pkg)),
      ]);
      return name;
    });
    aggregate("validate", ["lint", ...validations, "docs"]);
  }
  return { config: { packages: configs, version: 2 }, scripts };
}

/**
 * Return the linting and developer scripts enabled for one package.
 * @param pkg Package metadata that selects applicable tooling.
 * @returns Scripts keyed by their npm script names.
 * @example `commands({ path: ".", name: "app" })` returns the package scripts.
 */
function commands(pkg: PackageDescriptor): Record<string, string> {
  return {
    "check:rules": "npx --yes eslint-config-prettier eslint.config.ts",
    clean: "npx --yes rimraf dist",
    compile: "tsc --build --force ./tsconfig.app.json",
    eslint: "npx --yes eslint --max-warnings=0",
    "eslint:inspect": "npx --yes @eslint/config-inspector",
    fmt: "npm run prettier -- --write",
    "lint:staged": "npx --yes tsx scripts/lint-staged.ts",
    pack: pkg.extension
      ? "npx --yes @vscode/vsce package"
      : "npm pack --pack-destination dist",
    prettier: "npx --yes prettier --ignore-unknown --check .",
    "resolve-paths":
      "npx --yes tsc-alias --project ./tsconfig.app.json --resolve-full-paths",
    tdd: pkg.angular
      ? "ng test --watch=true --coverage=false"
      : "npm run test -- --watch --silent=true --coverage.enabled=false",
    test: pkg.angular
      ? "ng test --watch=false --coverage=true"
      : "npx --yes vitest run --no-color",
    typecheck: "tsc --project tsconfig.types.json",
    ...(!pkg.utility && {
      e2e:
        pkg.browser || pkg.playwright
          ? "npx --yes playwright test"
          : "npx --yes vitest run --no-color --config vitest.config.e2e.ts",
    }),
    ...(!pkg.angular && { mutation: "npx --yes stryker run" }),
    ...(pkg.styles && {
      stylelint: 'npx --yes stylelint --max-warnings=0 "**/*.{css,scss,sass}"',
      "stylelint:fix": "npm run stylelint -- --fix",
    }),
  };
}
