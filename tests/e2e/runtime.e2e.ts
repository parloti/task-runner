import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTasks } from "../../src/bootstrap/run.js";
import type { RunOptions } from "../../src/application/run-options.js";
import type { RunnerConfig } from "../../src/domain/types.js";

function fixture(
  tasks: RunnerConfig["packages"][string],
  scripts: Record<string, string> = {},
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "task runner "));
  const config: RunnerConfig = {
    version: 2,
    packages: { ".": { ...tasks, check: { dependsOn: ["end"] } } },
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

function stopOwnedProcess(pid: number): void {
  try {
    process.kill(pid, 0);
    process.kill(pid);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
}

describe("real runtime", () => {
  beforeEach(() => {
    vi.stubEnv("CI", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("retains only the failed command log and leaves cancellation as state, not an error", async () => {
    // Arrange
    const directory = fixture({
      failure: {
        run: {
          kind: "shell",
          command: `node -e "const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync('sibling-started')){clearInterval(t);console.error('actual failure');process.exitCode=7}},10)"`,
        },
      },
      sibling: {
        run: {
          kind: "shell",
          command: `node -e "require('fs').writeFileSync('sibling-started','yes');console.log('cancelled output');setTimeout(()=>{},30000)"`,
        },
      },
      end: { dependsOn: ["failure", "sibling"] },
    });
    try {
      // Act
      const result = await runTasks("check", {
        cwd: directory,
        concurrency: 2,
      });
      // Assert
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        message: expect.stringContaining("Command failed (7): failure"),
      });
      expect([...result.states.values()]).toContain("cancelled");
      const pidDirectory = path.join(
        directory,
        "logs",
        "task-runner",
        String(process.pid),
      );
      const logs = readdirSync(pidDirectory).filter((name) =>
        name.endsWith(".log"),
      );
      expect(logs).toEqual([expect.stringMatching(/^failure-.*\.log$/)]);
      expect(readFileSync(path.join(pidDirectory, logs[0]!), "utf8")).toContain(
        "actual failure",
      );
      const eventsFile = readdirSync(pidDirectory).find((name) =>
        name.endsWith(".jsonl"),
      )!;
      const events = readFileSync(path.join(pidDirectory, eventsFile), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        events.find((event) => event.status === "cancelled"),
      ).not.toHaveProperty("error");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("delivers only the validated selected plan before logs or events", async () => {
    // Arrange
    const directory = fixture({
      before: {},
      end: { dependsOn: ["before"] },
      unused: {},
    });
    const events = vi.fn();
    const plan = vi.fn<NonNullable<RunOptions["onPlan"]>>((graph, target) => {
      expect(target).toBe("check");
      expect([...graph.keys()]).toEqual(["before", "end", "check"]);
      expect(events).not.toHaveBeenCalled();
      expect(existsSync(path.join(directory, "logs"))).toBe(false);
    });
    try {
      // Act
      const result = await runTasks("check", {
        cwd: directory,
        onPlan: plan,
        onEvent: events,
      });
      // Assert
      expect(result.success).toBe(true);
      expect(plan).toHaveBeenCalledOnce();
      expect(events).toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("propagates a plan observer failure before creating outputs", async () => {
    // Arrange
    const directory = fixture({ end: {} });
    const error = new Error("Display unavailable");
    try {
      // Act & Assert
      await expect(
        runTasks("check", {
          cwd: directory,
          onPlan: () => {
            throw error;
          },
        }),
      ).rejects.toBe(error);
      expect(existsSync(path.join(directory, "logs"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("cancels an npm-owned descendant and waits for its output streams to close", async () => {
    // Arrange
    const directory = fixture(
      { end: { run: { kind: "npm", script: "serve" } } },
      {
        serve: `node -e "const fs=require('fs');fs.writeFileSync('owned-pid',String(process.pid));setTimeout(()=>{},10000)"`,
      },
    );
    const controller = new AbortController();
    const pidFile = path.join(directory, "owned-pid");
    let ownedPid: number | undefined;
    // Act
    const execution = runTasks("check", {
      cwd: directory,
      signal: controller.signal,
    });
    try {
      const deadline = Date.now() + 20000;
      while (!existsSync(pidFile) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (!existsSync(pidFile)) throw new Error("Owned command did not start");
      ownedPid = Number(readFileSync(pidFile, "utf8"));
      controller.abort(new Error("user cancellation"));
      const result = await execution;
      // Assert
      expect(result.success).toBe(false);
      expect(() => process.kill(ownedPid!, 0)).toThrow();
      expect([...result.states.values()]).toContain("cancelled");
      expect(result.errors).toEqual([]);
      expect(
        readdirSync(
          path.join(directory, "logs", "task-runner", String(process.pid)),
        ).every((name) => name.endsWith(".jsonl")),
      ).toBe(true);
    } finally {
      controller.abort();
      try {
        await execution;
      } finally {
        if (ownedPid !== undefined) stopOwnedProcess(ownedPid);
        rmSync(directory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    }
  }, 45000);
  it("rejects unknown targets and invalid concurrency before creating outputs", async () => {
    // Arrange
    const directory = fixture({ end: {} });
    try {
      // Act & Assert
      await expect(
        runTasks("unknown", {
          config: path.join(directory, "task-runner.json"),
          package: ".",
        }),
      ).rejects.toThrow("Unknown task");
      await expect(
        runTasks("check", { cwd: directory, concurrency: 0 }),
      ).rejects.toThrow("Concurrency");
      expect(existsSync(path.join(directory, "logs"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("preserves npm hooks and argument boundaries with a space-containing cwd", async () => {
    // Arrange
    const directory = fixture(
      {
        end: {
          run: {
            kind: "npm",
            script: "check",
            args: ["hello world", "a&b", ""],
          },
        },
      },
      {
        precheck: `node -e "require('fs').writeFileSync('pre','yes')"`,
        check: `node -e "require('fs').writeFileSync('args',JSON.stringify(process.argv.slice(1)))"`,
        postcheck: `node -e "require('fs').writeFileSync('post','yes')"`,
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
      expect(readdirSync(logs)).toEqual([String(process.pid)]);
      expect(readdirSync(path.join(logs, String(process.pid)))).toEqual([
        expect.stringMatching(/^events-[\da-f-]+\.jsonl$/),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates concurrent failed logs and captures both output streams", async () => {
    // Arrange
    const directory = fixture({
      end: {
        run: {
          kind: "shell",
          command: `node -e "console.log('out');console.error('err');process.exitCode=7"`,
        },
      },
    });
    try {
      // Act
      const results = await Promise.all([
        runTasks("check", { cwd: directory }),
        runTasks("check", { cwd: directory }),
      ]);
      // Assert
      expect(results.every((result) => !result.success)).toBe(true);
      const logRoot = path.join(directory, "logs", "task-runner");
      expect(readdirSync(logRoot)).toEqual([String(process.pid)]);
      const pidDirectory = path.join(logRoot, String(process.pid));
      const files = readdirSync(pidDirectory);
      const logs = files.filter((name) => name.endsWith(".log"));
      expect(logs).toHaveLength(2);
      expect(files.filter((name) => name.startsWith("events-"))).toHaveLength(
        2,
      );
      for (const log of logs) {
        expect(log).toMatch(/^end-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.log$/);
        expect(readFileSync(path.join(pidDirectory, log), "utf8")).toContain(
          "out",
        );
        expect(readFileSync(path.join(pidDirectory, log), "utf8")).toContain(
          "err",
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preflights missing scripts without creating logs or running prerequisites", async () => {
    // Arrange
    const directory = fixture({
      before: {
        run: {
          kind: "shell",
          command: "node -e \"require('fs').writeFileSync('bad','bad')\"",
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
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("selects workspace-local tasks and skips optional docs", async () => {
    // Arrange
    const directory = fixture({
      end: { run: { kind: "npm", script: "docs", optional: true } },
    });
    const workspace = path.join(directory, "packages", "one");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "package.json"), '{"name":"one"}');
    writeFileSync(
      path.join(directory, "task-runner.json"),
      JSON.stringify({
        version: 2,
        packages: {
          ".": { check: {} },
          "packages/one": {
            check: { run: { kind: "npm", script: "docs", optional: true } },
          },
        },
      }),
    );
    try {
      // Act
      const result = await runTasks("check", {
        cwd: workspace,
        ci: true,
        concurrency: 8,
      });
      // Assert
      expect([...result.states.values()]).toEqual(["skipped"]);
      expect(result.success).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
