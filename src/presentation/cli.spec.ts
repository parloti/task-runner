import { describe, expect, it } from "vitest";
import { parseArguments } from "./cli.js";

describe("command-line contract", () => {
  it("accepts --scroll without changing execution options", () => {
    // Arrange & Act
    const result = parseArguments([
      "validate",
      "--scroll",
      "--collapse",
      "false",
      "--max-tasks",
      "1000",
    ]);
    // Assert
    expect(result.options).toEqual({
      scroll: true,
      collapse: false,
      maxTasks: 1000,
    });
  });
  it.each([1, 100, 250])("parses task-list limit %i", (maxTasks) => {
    // Arrange & Act
    const result = parseArguments([
      "validate",
      "--max-tasks",
      String(maxTasks),
    ]);
    // Assert
    expect(result.options.maxTasks).toBe(maxTasks);
  });
  it.each(["true", "false"])("parses --collapse %s", (value) => {
    // Arrange & Act
    const result = parseArguments(["build", "--collapse", value]);
    // Assert
    expect(result.options.collapse).toBe(value === "true");
  });
  it("parses entrypoints, package/config overrides, CI, and positive concurrency", () => {
    // Arrange & Act
    const result = parseArguments([
      "run",
      "build",
      "--config",
      "custom.json",
      "--package",
      "apps/web",
      "--ci",
      "--concurrency",
      "3",
    ]);
    // Assert
    expect(result).toEqual({
      entrypoint: "build",
      help: false,
      options: {
        config: "custom.json",
        package: "apps/web",
        ci: true,
        concurrency: 3,
        scroll: true,
      },
    });
    expect(parseArguments(["build"]).entrypoint).toBe("build");
    expect(parseArguments(["--help"]).help).toBe(true);
  });

  it.each([
    [],
    ["run"],
    ["one", "two"],
    ["build", "--concurrency", "0"],
    ["build", "--concurrency", "1.5"],
    ["build", "--concurrency", "oops"],
    ["build", "--collapse", "yes"],
    ["build", "--collapse"],
    ["build", "--max-tasks", "0"],
    ["build", "--max-tasks", "-1"],
    ["build", "--max-tasks", "1.5"],
    ["build", "--max-tasks", "oops"],
    ["build", "--max-tasks", "9007199254740992"],
    ["build", "--max-tasks"],
    ["--unknown"],
  ])("rejects invalid invocations %j", (...args) => {
    // Arrange & Act & Assert
    expect(() => parseArguments(args)).toThrow();
  });
});
