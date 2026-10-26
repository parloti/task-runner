import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunnerConfig, RunOptions } from "../../src";

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

/**
 * Stop a process started by the current end-to-end test.
 * @param pid Process identifier owned by the test.
 * @example `stopOwnedProcess(child.pid)` cleans up the test child process.
 */
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
      end: { dependsOn: ["failure", "sibling"] },
      failure: {
        run: {
          command: `node -e "const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync('sibling-started')){clearInterval(t);console.error('actual failure');process.exitCode=7}},10)"`,
          kind: "shell",
        },
      },
      sibling: {
        run: {
          command: `node -e "require('fs').writeFileSync('sibling-started','yes');console.log('cancelled output');setTimeout(()=>{},30000)"`,
          kind: "shell",
        },
      },
    });
    try {
      // Act
      const result = await runTasks("check", {
        concurrency: 2,
        cwd: directory,
      });
      // Assert
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      const firstError: unknown = result.errors[0];
      const hasFailureMessage =
        firstError instanceof Error &&
        firstError.message.includes("Command failed (7): failure");
      expect(hasFailureMessage).toBe(true);
      expect(result.states.values().toArray()).toContain("cancelled");
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
      const firstLog = logs.at(0);
      if (firstLog === undefined) throw new Error("Expected a task log");
      expect(readFileSync(path.join(pidDirectory, firstLog), "utf8")).toContain(
        "actual failure",
      );
      const eventsFile = readdirSync(pidDirectory).find((name) =>
        name.endsWith(".jsonl"),
      );
      if (eventsFile === undefined) throw new Error("Expected an events log");
      const events: Record<string, unknown>[] = readFileSync(
        path.join(pidDirectory, eventsFile),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const cancellation = events.find(
        (event) =>
          event["taskId"] === "sibling" && event["status"] === "cancelled",
      );
      expect(cancellation).toBeDefined();
      expect(cancellation).not.toHaveProperty("error");
    } finally {
      rmSync(directory, { force: true, recursive: true });
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
      expect(graph.keys().toArray()).toEqual(["before", "end", "check"]);
      expect(events).not.toHaveBeenCalled();
      expect(existsSync(path.join(directory, "logs"))).toBe(false);
    });
    try {
      // Act
      const result = await runTasks("check", {
        cwd: directory,
        onEvent: events,
        onPlan: plan,
      });
      // Assert
      expect(result.success).toBe(true);
      expect(plan).toHaveBeenCalledOnce();
      expect(events).toHaveBeenCalled();
    } finally {
      rmSync(directory, { force: true, recursive: true });
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
      rmSync(directory, { force: true, recursive: true });
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
      const deadline = Date.now() + 20_000;
      while (!existsSync(pidFile) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (!existsSync(pidFile)) throw new Error("Owned command did not start");
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error("Owned command reported an invalid process ID");
      ownedPid = pid;
      controller.abort(new Error("user cancellation"));
      const result = await execution;
      // Assert
      expect(result.success).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(result.states.values().toArray()).toContain("cancelled");
      expect(result.errors).toEqual([]);
      const pidLogDirectory = path.join(
        directory,
        "logs",
        "task-runner",
        String(process.pid),
      );
      expect(
        readdirSync(pidLogDirectory).every((name) => name.endsWith(".jsonl")),
      ).toBe(true);
    } finally {
      controller.abort();
      try {
        await execution;
      } finally {
        if (ownedPid !== undefined) stopOwnedProcess(ownedPid);
        rmSync(directory, {
          force: true,
          maxRetries: 10,
          recursive: true,
          retryDelay: 100,
        });
      }
    }
  }, 45_000);
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
        runTasks("check", { concurrency: 0, cwd: directory }),
      ).rejects.toThrow("Concurrency");
      expect(existsSync(path.join(directory, "logs"))).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
