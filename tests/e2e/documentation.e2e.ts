import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const npm = process.env["npm_execpath"];
if (npm === undefined) throw new Error("The e2e suite must run through npm");

describe("API documentation", () => {
  it("generates the package and presets APIs without network access", () => {
    // Arrange
    const directory = mkdtempSync(path.join(os.tmpdir(), "runner-docs-"));
    const html = path.join(directory, "html");
    const json = path.join(directory, "api.json");
    try {
      // Act
      const generated = spawnSync(
        process.execPath,
        [npm, "run", "docs:api", "--", "--out", html, "--json", json],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, npm_config_offline: "true" },
          timeout: 60_000,
          windowsHide: true,
        },
      );

      // Assert
      assert.equal(
        generated.status,
        0,
        `${generated.error?.message ?? ""}\n${generated.stdout}\n${generated.stderr}`,
      );
      expect(existsSync(path.join(html, "index.html"))).toBe(true);
      const documentation = JSON.parse(readFileSync(json, "utf8")) as {
        children: { children?: { name: string }[]; name: string }[];
      };
      const exportsOf = (name: string) =>
        documentation.children
          .find((module) => module.name === name)
          ?.children?.map((item) => item.name);
      expect(exportsOf("index")).toEqual(
        expect.arrayContaining([
          "compileGraph",
          "createWorkspacePreset",
          "executeGraph",
          "runTasks",
        ]),
      );
      expect(exportsOf("presets")).toEqual(
        expect.arrayContaining([
          "createWorkspacePreset",
          "PackageDescriptor",
          "WorkspacePreset",
        ]),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
