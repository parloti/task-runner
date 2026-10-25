import type { RunnerConfig, TaskDefinition } from "../domain/types.js";

export interface PackageDescriptor {
  readonly path: string;
  readonly name: string;
  readonly angular?: boolean;
  readonly extension?: boolean;
  readonly utility?: boolean;
  readonly browser?: boolean;
  readonly playwright?: boolean;
  readonly styles?: boolean;
  readonly internalDependencies?: readonly string[];
}

export interface WorkspacePreset {
  readonly config: RunnerConfig;
  readonly scripts: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const key = (packagePath: string, task: string): string =>
  `${packagePath}#${task}`;

function commands(pkg: PackageDescriptor): Record<string, string> {
  return {
    "lint:staged": "npx --yes tsx scripts/lint-staged.ts",
    "eslint:inspect": "npx --yes @eslint/config-inspector",
    fmt: "npm run prettier -- --write",
    prettier: "npx --yes prettier --ignore-unknown --check .",
    "check:rules": "npx --yes eslint-config-prettier eslint.config.ts",
    eslint: "npx --yes eslint --max-warnings=0",
    typecheck: "tsc --project tsconfig.types.json",
    pack: pkg.extension
      ? "npx --yes @vscode/vsce package"
      : "npm pack --pack-destination dist",
    test: pkg.angular
      ? "ng test --watch=false --coverage=true"
      : "npx --yes vitest run --no-color",
    tdd: pkg.angular
      ? "ng test --watch=true --coverage=false"
      : "npm run test -- --watch --silent=true --coverage.enabled=false",
    clean: "npx --yes rimraf dist",
    compile: "tsc --build --force ./tsconfig.app.json",
    "resolve-paths":
      "npx --yes tsc-alias --project ./tsconfig.app.json --resolve-full-paths",
    ...(!pkg.utility
      ? {
          e2e:
            pkg.browser || pkg.playwright
              ? "npx --yes playwright test"
              : "npx --yes vitest run --no-color --config vitest.config.e2e.ts",
        }
      : {}),
    ...(!pkg.angular ? { mutation: "npx --yes stryker run" } : {}),
    ...(pkg.styles
      ? {
          stylelint:
            'npx --yes stylelint --max-warnings=0 "**/*.{css,scss,sass}"',
          "stylelint:fix": "npm run stylelint -- --fix",
        }
      : {}),
  };
}

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
    if (pkg.path.includes("#"))
      throw new Error(`Invalid package path: ${pkg.path}; # is reserved`);
    const suffix = pkg.path.split("/").at(-1)!;
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
        ...(dependencies.length === 0 ? {} : { dependsOn: dependencies }),
        ...(run === undefined ? {} : { run }),
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
        ...(args === undefined ? {} : { args }),
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
      ...(internalBuilds.length === 0 ? {} : { dependsOn: internalBuilds }),
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
      ...(!pkg.utility ? ["e2e"] : []),
      ...(!pkg.angular ? ["mutation"] : []),
    ]);
    add("docs", ["build"], { kind: "npm", script: "docs", optional: true });
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
    const rootScripts = scripts["."]!;
    const tasks = configs["."]!;
    const aggregate = (name: string, dependencies: readonly string[]): void => {
      tasks[name] = {
        ...(dependencies.length === 0 ? {} : { dependsOn: dependencies }),
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
        (pkg) => configs[pkg.path]![name] !== undefined,
      );
      aggregate(
        name,
        members.map((pkg) => key(pkg.path, name)),
      );
      for (const pkg of members) {
        const alias = `${name}:${pkg.path.split("/").at(-1)!}`;
        tasks[alias] = { dependsOn: [key(pkg.path, name)] };
        rootScripts[alias] = `task-runner run ${
          /^[a-zA-Z0-9:._-]+$/.test(alias) ? alias : JSON.stringify(alias)
        }`;
      }
    }
    // Keep the root leaf distinct from the aggregate entrypoint.
    rootScripts["typecheck:root"] = rootScripts["typecheck"]!;
    tasks["typecheck:root"] = {
      dependsOn: ["build"],
      run: { kind: "npm", script: "typecheck:root" },
    };
    const rootTypechecks = workspaces.map((pkg) => {
      const name = "root-typecheck";
      configs[pkg.path]![name] = {
        dependsOn: [key(".", "build")],
        run: { kind: "npm", script: "typecheck" },
      };
      return key(pkg.path, name);
    });
    aggregate("typecheck", ["typecheck:root", ...rootTypechecks]);
    const gated = (name: string, pkg: PackageDescriptor): string => {
      const localTasks = configs[pkg.path]!;
      const original = localTasks[name]!;
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
      const name = `validate:${pkg.path.split("/").at(-1)!}`;
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
  return { config: { version: 2, packages: configs }, scripts };
}
