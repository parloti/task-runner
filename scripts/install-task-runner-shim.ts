import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const binDirectory = path.join(projectRoot, "node_modules", ".bin");

await mkdir(binDirectory, { recursive: true });

if (process.platform === "win32") {
  const shimPath = path.join(binDirectory, "task-runner.cmd");
  const shim = [
    "@ECHO OFF",
    'npx.cmd --yes tsx "%~dp0..\\..\\src\\bootstrap\\cli.ts" %*',
    "EXIT /B %ERRORLEVEL%",
    "",
  ].join("\r\n");

  await writeFile(shimPath, shim, "utf8");
} else {
  const shimPath = path.join(binDirectory, "task-runner");
  const shim = [
    "#!/bin/sh",
    'exec npx --yes tsx "$(dirname "$0")/../../src/bootstrap/cli.ts" "$@"',
    "",
  ].join("\n");

  await writeFile(shimPath, shim, "utf8");
  await chmod(shimPath, 0o755);
}
