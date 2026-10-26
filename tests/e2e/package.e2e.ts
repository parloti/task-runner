import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

const npm = process.env["npm_execpath"];
if (npm === undefined) throw new Error("The e2e suite must run through npm");

// npm run prepends every ancestor node_modules/.bin, including this repository's
// development shim; consumers must resolve only their installed executable.
const isolatedEnvironment = (): NodeJS.ProcessEnv => {
  const entries = Object.entries(process.env).filter(
    ([name]) => name.toUpperCase() !== "PATH",
  );
  const searchPath = (process.env["PATH"] ?? process.env["Path"] ?? "")
    .split(path.delimiter)
    .filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/i.test(entry))
    .join(path.delimiter);
  return { ...Object.fromEntries(entries), PATH: searchPath };
};

describe("packed distribution", () => {
  it("installs offline into a clean consumer and resolves only compiled bin/library/presets", () => {
    // Arrange
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-package-"));
    const artifacts = path.join(directory, "artifacts");
    const consumer = path.join(directory, "consumer");
    const packageRoot = path.join(directory, "package");
    mkdirSync(artifacts);
    mkdirSync(consumer);
    mkdirSync(packageRoot);
    for (const file of [
      "LICENSE",
      "README.md",
      "package.json",
      "schema.json",
      "task-runner.json",
      "tsconfig.app.json",
      "tsconfig.base.json",
    ]) {
      copyFileSync(path.join(root, file), path.join(packageRoot, file));
    }
    cpSync(path.join(root, "src"), path.join(packageRoot, "src"), {
      recursive: true,
    });
    symlinkSync(
      path.join(root, "node_modules"),
      path.join(packageRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    writeFileSync(
      path.join(consumer, "package.json"),
      JSON.stringify({
        name: "clean-consumer",
        private: true,
        scripts: {
          check: "task-runner run check",
          leaf: `node -e "process.exitCode=0"`,
        },
        type: "module",
      }),
    );
    writeFileSync(
      path.join(consumer, "task-runner.json"),
      JSON.stringify({
        packages: {
          ".": {
            build: { dependsOn: ["end"] },
            check: { dependsOn: ["build", "docs"] },
            docs: { run: { kind: "npm", optional: true, script: "docs" } },
            end: { run: { kind: "npm", script: "leaf" } },
          },
        },
        version: 2,
      }),
    );
    const invoke = (args: string[], cwd = consumer) =>
      spawnSync(process.execPath, args, {
        cwd,
        encoding: "utf8",
        env: isolatedEnvironment(),
        timeout: 60_000,
        windowsHide: true,
      });
    try {
      // Act
      const built = invoke([npm, "run", "build"], packageRoot);
      if (built.status === 0)
        writeFileSync(path.join(packageRoot, "dist", "previous.tgz"), "");
      const packed =
        built.status === 0
          ? invoke(
              [
                npm,
                "pack",
                "--json",
                "--ignore-scripts",
                "--pack-destination",
                artifacts,
              ],
              packageRoot,
            )
          : built;
      const manifest =
        packed.status === 0
          ? (
              JSON.parse(packed.stdout) as {
                filename: string;
                files: { path: string }[];
              }[]
            )[0]
          : undefined;
      const filename = manifest?.filename;
      const archive = filename ? path.join(artifacts, filename) : artifacts;
      // Resolve dependencies online once to create the consumer lockfile and
      // prime npm's cache. The clean install below must then work offline.
      const prepared =
        packed.status === 0
          ? invoke([
              npm,
              "install",
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              archive,
            ])
          : packed;
      const installed =
        prepared.status === 0
          ? invoke([
              npm,
              "ci",
              "--offline",
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
            ])
          : prepared;
      const cli =
        installed.status === 0
          ? invoke([
              npm,
              "run",
              "check",
              "--",
              "--ci",
              "--collapse",
              "false",
              "--concurrency",
              "2",
            ])
          : installed;
      const library =
        installed.status === 0
          ? invoke([
              "--input-type=module",
              "-e",
              `
        import {runTasks} from "@codeperfect/task-runner";
        import {createWorkspacePreset} from "@codeperfect/task-runner/presets";
        const result = await runTasks("check");
        const preset = createWorkspacePreset([{path:".",name:"consumer",utility:true}]);
        console.log(JSON.stringify({success:result.success,build:preset.scripts["."].build}));
      `,
            ])
          : installed;
      // Assert
      assert.equal(packed.status, 0, packed.stderr);
      expect(manifest?.files.map((file) => file.path)).toContain(
        "dist/bootstrap/cli.js",
      );
      expect(
        manifest?.files.filter((file) => file.path.endsWith(".tgz")),
      ).toEqual([]);
      assert.equal(installed.status, 0, installed.stderr);
      expect(
        existsSync(
          path.join(
            consumer,
            "node_modules",
            ".bin",
            process.platform === "win32" ? "task-runner.cmd" : "task-runner",
          ),
        ),
      ).toBe(true);
      assert.equal(cli.status, 0, cli.stderr);
      expect(cli.stderr).toContain("leaf (running");
      expect(cli.stderr).toMatch(/build \(succeeded, \d+\.\ds\)/);
      expect(cli.stderr).toContain("docs (skipped)");
      expect(cli.stderr).toMatch(/check \(succeeded, \d+\.\ds\)/);
      expect(cli.stderr).not.toContain('[".","');
      expect(cli.stderr).not.toContain("\u{1B}[");
      expect(cli.stderr).toMatch(
        /Tasks: 2 \| succeeded: 1 \| skipped: 1\r?\n\r?\n$/,
      );
      assert.equal(library.status, 0, library.stderr);
      expect(library.stdout).toContain('"success":true');
      expect(library.stdout).toContain('"build":"task-runner run build"');
      expect(
        existsSync(
          path.join(
            consumer,
            "node_modules",
            "@codeperfect",
            "task-runner",
            "src",
          ),
        ),
      ).toBe(false);
      expect(
        existsSync(
          path.join(
            consumer,
            "node_modules",
            "@codeperfect",
            "task-runner",
            "dist",
            "index.d.ts",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          path.join(
            consumer,
            "node_modules",
            "@codeperfect",
            "task-runner",
            "schema.json",
          ),
        ),
      ).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 90_000);
});
