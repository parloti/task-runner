import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("executable cache bypass", () => {
  it("reuses successful commands and executes them again with --no-cache", () => {
    // Arrange
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-cli-cache-"));
    try {
      const config = path.join(directory, "task-runner.json");
      writeFileSync(path.join(directory, "input.txt"), "unchanged");
      writeFileSync(
        config,
        JSON.stringify({
          packages: {
            ".": {
              check: {
                cache: { inputs: ["input.txt"] },
                run: {
                  command: `node -e "require('node:fs').appendFileSync('calls.log','ran\\n')"`,
                  kind: "shell",
                },
              },
            },
          },
          version: 2,
        }),
      );
      const loader = import.meta.resolve("jiti/register");
      const entry = path.resolve("src", "bootstrap", "cli.ts");
      const messages: string[] = [];
      // Act
      for (const args of [[], [], ["--no-cache"]]) {
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            loader,
            entry,
            "check",
            "--config",
            config,
            "--package",
            ".",
            ...args,
          ],
          { cwd: directory, encoding: "utf8", timeout: 60_000 },
        );
        if (result.status !== 0)
          throw new Error(
            `CLI exited with ${String(result.status)}: ${result.stderr}`,
            { cause: result.error },
          );
        messages.push(result.stderr);
      }
      // Assert
      expect(readFileSync(path.join(directory, "calls.log"), "utf8")).toBe(
        "ran\nran\n",
      );
      expect(messages.some((message) => message.includes("cached: 1"))).toBe(
        true,
      );
    } finally {
      rmSync(directory, {
        force: true,
        maxRetries: 10,
        recursive: true,
        retryDelay: 100,
      });
    }
  });
});
