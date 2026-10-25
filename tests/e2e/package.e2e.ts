import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { findNpmCli } from "../../src/infrastructure/process.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

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
        type: "module",
        scripts: {
          check: "task-runner run check",
          leaf: `node -e "process.exitCode=0"`,
        },
      }),
    );
    writeFileSync(
      path.join(consumer, "task-runner.json"),
      JSON.stringify({
        version: 2,
        packages: {
          ".": {
            check: { dependsOn: ["build", "docs"] },
            build: { dependsOn: ["end"] },
            end: { run: { kind: "npm", script: "leaf" } },
            docs: { run: { kind: "npm", script: "docs", optional: true } },
          },
        },
      }),
    );
    const npm = findNpmCli();
    const invoke = (args: string[], cwd = consumer) =>
      spawnSync(process.execPath, args, {
        cwd,
        encoding: "utf8",
        timeout: 60000,
      });
    try {
      // Act
      const built = invoke([npm, "run", "build"], packageRoot);
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
      const filename =
        packed.status === 0
          ? Object.values(
              JSON.parse(packed.stdout) as Record<string, { filename: string }>,
            )[0]?.filename
          : undefined;
      const archive = filename ? path.join(artifacts, filename) : artifacts;
      const installed =
        packed.status === 0
          ? invoke([
              npm,
              "install",
              "--offline",
              "--no-audit",
              "--no-fund",
              archive,
            ])
          : packed;
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
      expect(packed.status, packed.stderr).toBe(0);
      expect(installed.status, installed.stderr).toBe(0);
      expect(cli.status, cli.stderr).toBe(0);
      expect(cli.stderr).toContain("leaf (running");
      expect(cli.stderr).toMatch(/build \(succeeded, \d+\.\ds\)/);
      expect(cli.stderr).toContain("docs (skipped)");
      expect(cli.stderr).toMatch(/check \(succeeded, \d+\.\ds\)/);
      expect(cli.stderr).not.toContain('[".","');
      expect(cli.stderr).not.toContain("\u001b[");
      expect(cli.stderr).toMatch(
        /Tasks: 2 \| succeeded: 1 \| skipped: 1\r?\n\r?\n$/,
      );
      expect(library.status, library.stderr).toBe(0);
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
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90000);
});
