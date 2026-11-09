import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
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
  it("installs offline into a clean consumer and resolves only compiled bin/library/presets", async () => {
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
    cpSync(path.join(root, "scripts"), path.join(packageRoot, "scripts"), {
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
    const invoke = (args: string[], cwd = consumer) => {
      const result = spawnSync(process.execPath, args, {
        cwd,
        encoding: "utf8",
        env: isolatedEnvironment(),
        timeout: 120_000,
        windowsHide: true,
      });
      assert.equal(
        result.status,
        0,
        `${args.join(" ")} in ${cwd}\n${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
      );
      return result;
    };
    let failure: Error | undefined;
    try {
      // Act
      invoke([npm, "run", "build"], packageRoot);
      writeFileSync(path.join(packageRoot, "dist", "previous.tgz"), "");
      const packed = invoke(
        [
          npm,
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          artifacts,
        ],
        packageRoot,
      );
      const manifest = (
        JSON.parse(packed.stdout) as {
          filename: string;
          files: { path: string }[];
        }[]
      )[0];
      assert.ok(manifest, "npm pack must report an archive");
      const archive = path.join(artifacts, manifest.filename);
      // Resolve dependencies online once to create the consumer lockfile and
      // prime npm's cache. The clean install below must then work offline.
      invoke([
        npm,
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        archive,
      ]);
      invoke([
        npm,
        "ci",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ]);
      const cli = invoke([
        npm,
        "run",
        "check",
        "--",
        "--ci",
        "--collapse",
        "false",
        "--concurrency",
        "2",
      ]);
      const library = invoke([
        "--input-type=module",
        "-e",
        `
        import {runTasks} from "@codeperfect/task-runner";
        import {createWorkspacePreset} from "@codeperfect/task-runner/presets";
        const result = await runTasks("check");
        const preset = createWorkspacePreset([{path:".",name:"consumer",utility:true}]);
        console.log(JSON.stringify({success:result.success,build:preset.scripts["."].build}));
      `,
      ]);
      // Assert
      expect(manifest.files.map((file) => file.path)).toContain(
        "dist/bootstrap/cli.js",
      );
      expect(
        manifest.files.filter((file) => file.path.endsWith(".tgz")),
      ).toEqual([]);
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
      expect(cli.stderr).toContain("leaf (running");
      expect(cli.stderr).toMatch(/build \(succeeded, \d+\.\ds\)/);
      expect(cli.stderr).toContain("docs (skipped)");
      expect(cli.stderr).toMatch(/check \(succeeded, \d+\.\ds\)/);
      expect(cli.stderr).not.toContain('[".","');
      expect(cli.stderr).not.toContain("\u{1B}[");
      expect(cli.stderr).toMatch(
        /Tasks: 2 \| succeeded: 1 \| skipped: 1 \| Finished at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\r?\n\r?\n$/,
      );
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
      const installedPackageJson = JSON.parse(
        readFileSync(
          path.join(
            consumer,
            "node_modules",
            "@codeperfect",
            "task-runner",
            "package.json",
          ),
          "utf8",
        ),
      ) as { exports: Record<string, unknown> };
      expect(installedPackageJson.exports["."]).not.toHaveProperty("source");
      expect(installedPackageJson.exports["./presets"]).not.toHaveProperty(
        "source",
      );
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
    } catch (error) {
      failure =
        error instanceof Error
          ? error
          : new Error("Package test failed", { cause: error });
    }
    try {
      // Windows can briefly retain handles after a subprocess exits.
      await rm(directory, {
        force: true,
        maxRetries: 10,
        recursive: true,
        retryDelay: 100,
      });
    } catch (cleanupError) {
      if (failure !== undefined)
        throw new AggregateError(
          [failure, cleanupError],
          `Package test and cleanup failed: ${directory}`,
          { cause: cleanupError },
        );
      throw cleanupError;
    }
    if (failure !== undefined) throw failure;
  }, 180_000);
});
