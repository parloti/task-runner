import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { RunnerConfig } from "../../src";

import { runTasks } from "../../src";

describe("runtime task selection", () => {
  it.each([
    {
      expected: ["lib:mutation", "app:mutation"],
      scope: ".",
      target: "mutation",
    },
    { expected: ["app:mutation"], scope: ".", target: "mutation:app" },
    { expected: ["app:mutation"], scope: "app", target: "mutation" },
    { expected: ["app:test", "app:mutation"], scope: ".", target: "test:all" },
  ])(
    "starts $scope/$target at its selected commands",
    async ({ expected, scope, target }) => {
      // Arrange
      const directory = mkdtempSync(
        path.join(os.tmpdir(), "runner-selection-"),
      );
      const config: RunnerConfig = {
        packages: {
          ".": {
            mutation: {
              dependsOn: ["mutation:app", "mutation:lib", "mutation:app"],
            },
            "mutation:app": { dependsOn: ["app#mutation"] },
            "mutation:lib": { dependsOn: ["lib#mutation"] },
            "test:all": { dependsOn: ["app#mutation", "app#test"] },
          },
          app: {
            mutation: {
              dependsOn: ["test", "lib#mutation"],
              run: { kind: "npm", script: "mutation" },
            },
            test: { run: { kind: "npm", script: "test" } },
          },
          lib: {
            mutation: {
              dependsOn: ["test"],
              run: { kind: "npm", script: "mutation" },
            },
            test: { run: { kind: "npm", script: "test" } },
          },
        },
        version: 2,
      };
      writeFileSync(
        path.join(directory, "task-runner.json"),
        JSON.stringify(config),
      );
      writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({ name: "root" }),
      );
      for (const name of ["app", "lib"]) {
        const packageDirectory = path.join(directory, name);
        mkdirSync(packageDirectory);
        const scripts = Object.fromEntries(
          ["test", "mutation"].map((task) => [
            task,
            String.raw`node -e "require('node:fs').appendFileSync('../commands.log','${name}:${task}\n')"`,
          ]),
        );
        writeFileSync(
          path.join(packageDirectory, "package.json"),
          JSON.stringify({ name, scripts }),
        );
      }
      try {
        // Act
        const result = await runTasks(target, {
          concurrency: 4,
          cwd: directory,
          package: scope,
        });

        // Assert
        expect(result.errors).toEqual([]);
        expect(result.success).toBe(true);
        expect(
          readFileSync(path.join(directory, "commands.log"), "utf8")
            .trim()
            .split("\n"),
        ).toEqual(expected);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
});
