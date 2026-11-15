import { describe, expect, it } from "vitest";

import { parseConfiguration } from "./configuration";

const configWith = (cache: unknown) => ({
  packages: { ".": { test: { cache, run: { kind: "npm", script: "test" } } } },
  version: 2,
});

describe("cache configuration boundary", () => {
  it("preserves explicit file and environment declarations", () => {
    // Arrange
    const cache = {
      env: ["NODE_ENV"],
      exclude: ["src/generated/**"],
      inputs: ["src/**", "package-lock.json", "src/\\[literal\\]/**"],
      outputs: ["coverage/**"],
    };
    // Act
    const config = parseConfiguration(configWith(cache));
    // Assert
    expect(config.packages["."]?.["test"]?.cache).toEqual(cache);
  });

  it.each([
    JSON.parse("null") as unknown,
    [],
    true,
    {},
    { inputs: [] },
    { inputs: [42] },
    { inputs: "src/**" },
    { inputs: [""] },
    { inputs: ["../outside"] },
    { inputs: ["/outside"] },
    { inputs: ["C:\\outside"] },
    { inputs: ["./source"] },
    { inputs: ["!source"] },
    { env: [""], inputs: ["src/**"] },
    { inputs: ["src/**"], unknown: true },
  ])("rejects unsafe or malformed cache declarations: %j", (cache) => {
    // Arrange & Act & Assert
    expect(() => parseConfiguration(configWith(cache))).toThrow();
  });
});
