import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { RunnerConfig } from "../../src";

import { runTasks } from "../../src";

/**
 * Create a temporary package fixture for runtime integration scenarios.
 * @param tasks Root package task definitions for the fixture.
 * @param scripts Optional npm scripts declared by the fixture package.
 * @returns The fixture path and parsed runner configuration.
 * @example `fixture({ build: { run: command } })` creates a runnable fixture.
 */
function fixture(
  tasks: RunnerConfig["packages"][string],
  scripts: Record<string, string> = {},
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "task runner "));
  const config: RunnerConfig = {
    packages: { ".": { ...tasks, check: { dependsOn: ["end"] } } },
    version: 2,
  };
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "fixture", scripts }),
  );
  writeFileSync(
    path.join(directory, "task-runner.json"),
    JSON.stringify(config),
  );
  return directory;
}

describe("real runtime", () => {
  it("preserves npm hooks and argument boundaries with a space-containing cwd", async () => {
    // Arrange
    const directory = fixture(
      {
        end: {
          run: {
            args: ["hello world", "a&b", ""],
            kind: "npm",
            script: "check",
          },
        },
      },
      {
        check: `node -e "require('fs').writeFileSync('args',JSON.stringify(process.argv.slice(1)))"`,
        postcheck: `node -e "require('fs').writeFileSync('post','yes')"`,
        precheck: `node -e "require('fs').writeFileSync('pre','yes')"`,
      },
    );
    try {
      // Act
      const result = await runTasks("check", { cwd: directory });
      // Assert
      expect(result.success).toBe(true);
      expect(readFileSync(path.join(directory, "args"), "utf8")).toBe(
        '["hello world","a&b",""]',
      );
      expect(existsSync(path.join(directory, "pre"))).toBe(true);
      expect(existsSync(path.join(directory, "post"))).toBe(true);
      const logs = path.join(directory, "logs", "task-runner");
      expect(readdirSync(logs)).toEqual([
        expect.stringMatching(/^events-[\da-f-]+\.jsonl$/),
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("isolates concurrent failed logs and captures both output streams", async () => {
    // Arrange
    const directory = fixture({
      end: {
        run: {
          command: `node -e "console.log('out');console.error('err');process.exitCode=7"`,
          kind: "shell",
        },
      },
    });
    try {
      const logRoot = path.join(directory, "logs", "task-runner");
      mkdirSync(logRoot, { recursive: true });
      writeFileSync(path.join(logRoot, "old.log"), "stale output");
      // Act
      const results = await Promise.all([
        runTasks("check", { cwd: directory }),
        runTasks("check", { cwd: directory }),
      ]);
      // Assert
      expect(results.every((result) => !result.success)).toBe(true);
      const files = readdirSync(logRoot);
      expect(files).not.toContain("old.log");
      const logs = files.filter((name) => name.endsWith(".log"));
      expect(logs).toHaveLength(2);
      expect(files.filter((name) => name.startsWith("events-"))).toHaveLength(
        2,
      );
      for (const log of logs) {
        expect(log).toMatch(
          new RegExp(
            String.raw`^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-end-${String(process.pid)}\.log$`,
          ),
        );
        expect(readFileSync(path.join(logRoot, log), "utf8")).toContain("out");
        expect(readFileSync(path.join(logRoot, log), "utf8")).toContain("err");
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("preflights missing scripts without creating logs or running prerequisites", async () => {
    // Arrange
    const directory = fixture({
      before: {
        run: {
          command: "node -e \"require('fs').writeFileSync('bad','bad')\"",
          kind: "shell",
        },
      },
      end: { dependsOn: ["before"], run: { kind: "npm", script: "missing" } },
    });
    const onPlan = vi.fn();
    try {
      // Act & Assert
      await expect(
        runTasks("check", { cwd: directory, onPlan }),
      ).rejects.toThrow("Missing required");
      expect(existsSync(path.join(directory, "bad"))).toBe(false);
      expect(existsSync(path.join(directory, "logs"))).toBe(false);
      expect(onPlan).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("selects workspace-local tasks and skips optional docs", async () => {
    // Arrange
    const directory = fixture({
      end: { run: { kind: "npm", optional: true, script: "docs" } },
    });
    const workspace = path.join(directory, "packages", "one");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "package.json"), '{"name":"one"}');
    writeFileSync(
      path.join(directory, "task-runner.json"),
      JSON.stringify({
        packages: {
          ".": { check: {} },
          "packages/one": {
            check: { run: { kind: "npm", optional: true, script: "docs" } },
          },
        },
        version: 2,
      }),
    );
    try {
      // Act
      const result = await runTasks("check", {
        ci: true,
        concurrency: 8,
        cwd: workspace,
      });
      // Assert
      expect(result.states.values().toArray()).toEqual(["skipped"]);
      expect(result.success).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
