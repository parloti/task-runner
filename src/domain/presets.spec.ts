import { describe, expect, it } from "vitest";

import { createWorkspacePreset } from "./presets";

describe("createWorkspacePreset", () => {
  it("returns a JSON-compatible version-2 config and omits empty dependencies", () => {
    // Arrange
    const packages = {
      ".": {
        build: { dependsOn: [], run: { kind: "npm", script: "build" } },
        validate: { cache: { inputs: ["src/**/*"] }, dependsOn: ["build"] },
      },
      "packages/lib": {
        test: { run: { command: "node test.js", kind: "shell" } },
      },
    } as const;

    // Act
    const config = createWorkspacePreset({
      defaults: { concurrency: 2 },
      packages,
    });

    // Assert
    expect(config).toEqual({
      defaults: { concurrency: 2 },
      packages: {
        ".": {
          build: { run: { kind: "npm", script: "build" } },
          validate: { cache: { inputs: ["src/**/*"] }, dependsOn: ["build"] },
        },
        "packages/lib": {
          test: { run: { command: "node test.js", kind: "shell" } },
        },
      },
      version: 2,
    });
    expect(structuredClone(config)).toEqual(config);
  });
});
