import { describe, expect, it } from "vitest";

import { formatInvocation } from "./invocation";

const args = [
  "run",
  "validate",
  "--scroll",
  "--collapse",
  "false",
  "--concurrency",
  "4",
  "--max-tasks",
  "1000",
];

describe("display invocation", () => {
  it("reconstructs an npm script with the original argument order", () => {
    // Arrange & Act
    const command = formatInvocation(args, {
      npm_command: "run-script",
      npm_lifecycle_event: "validate",
      npm_lifecycle_script: "task-runner run validate",
    });
    // Assert
    expect(command).toBe(
      "npm run validate -- --scroll --collapse false --concurrency 4 --max-tasks 1000",
    );
  });

  it("omits flags already defined in the npm script and omits an empty separator", () => {
    // Arrange
    const environment = {
      npm_command: "run-script",
      npm_lifecycle_event: "check",
      npm_lifecycle_script: " task-runner   run validate --scroll ",
    };
    // Act & Assert
    expect(formatInvocation(args, environment)).toBe(
      "npm run check -- --collapse false --concurrency 4 --max-tasks 1000",
    );
    expect(formatInvocation(["run", "validate", "--scroll"], environment)).toBe(
      "npm run check",
    );
  });

  it.each([
    {},
    {
      npm_command: "exec",
      npm_lifecycle_event: "validate",
      npm_lifecycle_script: "task-runner run validate",
    },
    { npm_command: "run-script", npm_lifecycle_event: "validate" },
    {
      npm_command: "run-script",
      npm_lifecycle_script: "task-runner run validate",
    },
    {
      npm_command: "run-script",
      npm_lifecycle_event: "validate",
      npm_lifecycle_script: "tsx custom.ts",
    },
    {
      npm_command: "run-script",
      npm_lifecycle_event: "validate",
      npm_lifecycle_script: "task-runner run other",
    },
    {
      npm_command: "run-script",
      npm_lifecycle_event: "validate",
      npm_lifecycle_script: "task-runner run validate --scroll --ci",
    },
  ])(
    "uses the direct runner invocation when npm context is missing or unrelated: %j",
    (environment) => {
      // Arrange & Act & Assert
      expect(formatInvocation(args, environment)).toBe(
        "task-runner run validate --scroll --collapse false --concurrency 4 --max-tasks 1000",
      );
    },
  );

  it("quotes whitespace, empty values, quotes, shell metacharacters, and control characters", () => {
    // Arrange & Act
    const command = formatInvocation(
      [
        "run",
        "build",
        "--config",
        "a b.json",
        "",
        'a"b',
        "$HOME",
        "\u{1B}[2J\n",
      ],
      {},
    );
    // Assert
    expect(command).toBe(
      'task-runner run build --config "a b.json" "" "a\\"b" "$HOME" "\\u001b[2J\\n"',
    );
  });
});
