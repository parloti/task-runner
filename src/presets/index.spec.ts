import { describe, expect, it } from "vitest";
import { compileGraph } from "../domain/graph.js";
import { createWorkspacePreset } from "./index.js";

describe("workflow presets", () => {
  it("omits empty dependencies from aggregates with no eligible workspace commands", () => {
    // Arrange & Act
    const preset = createWorkspacePreset([
      { path: ".", name: "root" },
      { path: "lib", name: "library", utility: true },
    ]);
    // Assert
    expect(preset.config.packages["."]!["e2e"]).toEqual({});
    expect(JSON.stringify(preset.config)).not.toContain('"dependsOn":[]');
  });

  it("rejects package paths containing the reference separator", () => {
    // Arrange & Act & Assert
    expect(() =>
      createWorkspacePreset([
        { path: ".", name: "root" },
        { path: "lib#part", name: "library" },
      ]),
    ).toThrow("# is reserved");
  });
  it.each([false, true])(
    "gates documentation on completed builds (monorepo=%s)",
    (monorepo) => {
      // Arrange
      const preset = createWorkspacePreset([
        { path: ".", name: "root" },
        ...(monorepo
          ? [
              { path: "packages/lib", name: "lib", utility: true },
              { path: "apps/web", name: "web", internalDependencies: ["lib"] },
            ]
          : []),
      ]);
      const scripts = new Map(
        Object.entries(preset.scripts).map(([path, commands]) => [
          path,
          { ...commands, docs: "node docs.js" },
        ]),
      );
      // Act
      const graph = compileGraph(preset.config, "docs", scripts);
      // Assert
      expect(preset.config.packages["."]!["docs"]?.dependsOn).toEqual([
        "build",
      ]);
      expect([...graph.keys()].at(-1)).toBe("docs");
      for (const path of monorepo ? ["packages/lib", "apps/web"] : ["."]) {
        const build = path === "." ? "build" : `${path}#build`;
        expect([...graph.keys()]).toContain(build);
        expect(preset.config.packages[path]!["docs"]?.dependsOn).toEqual([
          "build",
        ]);
      }
    },
  );
  it("leaves repository-specific lifecycle hooks unmanaged", () => {
    // Arrange & Act
    const preset = createWorkspacePreset([{ path: ".", name: "root" }]);
    // Assert
    expect(preset.scripts["."]).not.toHaveProperty("prepare");
  });
  it("quotes aliases when workspace directories contain spaces", () => {
    // Arrange & Act
    const preset = createWorkspacePreset([
      { path: ".", name: "root" },
      { path: "packages/my library", name: "library" },
    ]);
    // Assert
    expect(preset.scripts["."]!["build:my library"]).toBe(
      'task-runner run "build:my library"',
    );
  });
  it("selects extension packaging, Playwright, and style fixes explicitly", () => {
    // Arrange & Act
    const preset = createWorkspacePreset([
      {
        path: ".",
        name: "extension",
        extension: true,
        playwright: true,
        styles: true,
      },
    ]);
    // Assert
    expect(preset.scripts["."]!["pack"]).toBe("npx --yes @vscode/vsce package");
    expect(preset.scripts["."]!["e2e"]).toBe("npx --yes playwright test");
    expect(preset.scripts["."]!["stylelint:fix"]).toBe(
      "npm run stylelint -- --fix",
    );
  });
  it("generates standalone dependency ordering and optional docs", () => {
    // Arrange
    const preset = createWorkspacePreset([{ path: ".", name: "one" }]);
    // Act
    const target = "build";
    const graph = compileGraph(
      preset.config,
      target,
      new Map(Object.entries(preset.scripts)),
    );
    // Assert
    expect(
      [...graph.values()].map((task) =>
        task.run?.kind === "npm" ? task.run.script : "group",
      ),
    ).toEqual(["clean", "compile", "resolve-paths", "group"]);
    expect(preset.scripts["."]!["validate:ci"]).toBe(
      "task-runner run validate --ci",
    );
  });

  it("builds workspace dependencies once and gates root validation without workspace lint", () => {
    // Arrange
    const preset = createWorkspacePreset([
      { path: ".", name: "root", styles: true },
      { path: "packages/lib", name: "@example/lib", utility: true },
      {
        path: "apps/web",
        name: "web",
        angular: true,
        browser: true,
        internalDependencies: ["@example/lib"],
      },
    ]);
    // Act
    const target = "validate";
    const graph = compileGraph(
      preset.config,
      target,
      new Map(Object.entries(preset.scripts)),
    );
    // Assert
    expect(
      [...graph.values()]
        .filter(
          (task) => task.run?.kind === "npm" && task.run.script === "eslint",
        )
        .map((task) => task.package),
    ).toEqual(["."]);
    expect(
      [...graph.values()].filter((task) => task.id === "packages/lib#build"),
    ).toHaveLength(1);
    expect(preset.scripts["apps/web"]!["test"]).toContain("ng test");
    expect(preset.scripts["apps/web"]!["mutation"]).toBeUndefined();
    expect(preset.scripts["packages/lib"]!["e2e"]).toBeUndefined();
    expect(preset.config.packages["."]!["build:web"]?.dependsOn).toEqual([
      "apps/web#build",
    ]);
    expect(preset.config.packages["."]![target]?.dependsOn).toEqual([
      "lint",
      "validate:lib",
      "validate:web",
      "docs",
    ]);
    expect(preset.scripts["."]!["validate:web"]).toBe(
      "task-runner run validate:web",
    );
    const workspaceGraph = compileGraph(
      preset.config,
      "validate:web",
      new Map(Object.entries(preset.scripts)),
    );
    expect(
      [...workspaceGraph.values()].some(
        (task) => task.run?.kind === "npm" && task.run.script === "eslint",
      ),
    ).toBe(false);
    expect(
      preset.config.packages["apps/web"]!["validate"]?.dependsOn,
    ).toContain("lint");
  });

  it.each([false, true])(
    "omits empty dependencies and uses pack as a direct command (monorepo=%s)",
    (monorepo) => {
      // Arrange & Act
      const preset = createWorkspacePreset([
        { path: ".", name: "root" },
        ...(monorepo ? [{ path: "apps/web", name: "web" }] : []),
      ]);
      // Assert
      expect(preset.config).not.toHaveProperty("tasks");
      for (const [packagePath, pkg] of Object.entries(preset.config.packages)) {
        expect(pkg).not.toHaveProperty("entrypoints");
        expect(pkg).not.toHaveProperty("pack:artifact");
        for (const task of Object.values(pkg)) {
          expect(task).not.toHaveProperty("package");
          if (task.dependsOn !== undefined)
            expect(task.dependsOn.length).toBeGreaterThan(0);
        }
        if (!monorepo || packagePath !== ".") {
          expect(pkg["pack"]).toEqual({
            dependsOn: ["build"],
            run: { kind: "npm", script: "pack" },
          });
          expect(preset.scripts[packagePath]!["pack"]).toBe(
            "npm pack --pack-destination dist",
          );
        }
      }
      expect(JSON.stringify(preset.config)).not.toContain('\\"');
    },
  );

  it.each([
    { packages: [] },
    {
      packages: [
        { path: ".", name: "root" },
        { path: "a/x", name: "a" },
        { path: "b/x", name: "b" },
      ],
    },
    {
      packages: [
        { path: ".", name: "root" },
        { path: "a", name: "root" },
      ],
    },
    {
      packages: [
        { path: ".", name: "root" },
        { path: "a", name: "a", internalDependencies: ["absent"] },
      ],
    },
  ])("rejects invalid package inventories", ({ packages }) => {
    // Arrange & Act & Assert
    expect(() => createWorkspacePreset(packages)).toThrow();
  });
});
