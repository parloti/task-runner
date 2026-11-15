import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFailedTaskStore } from "./failed-task-store";

const fixture = { root: "" };
const recordPath = (): string =>
  path.join(fixture.root, ".cache", "task-runner", "last-failed-tasks.json");

beforeEach(() => {
  fixture.root = mkdtempSync(path.join(tmpdir(), "runner-failed-tasks-"));
});

afterEach(() => {
  rmSync(fixture.root, { force: true, recursive: true });
});

describe("latest failed task store", () => {
  it("keeps separate config records and ignores older concurrent updates", async () => {
    // Arrange
    const defaultStore = createFailedTaskStore(fixture.root);
    const alternateStore = createFailedTaskStore(
      fixture.root,
      path.join(fixture.root, "alternate.json"),
    );

    // Act
    await defaultStore.write(["current"], 200, "z-run");
    await defaultStore.write(["stale"], 100, "old-run");
    await alternateStore.write(["alternate"], 150, "alternate-run");

    // Assert
    expect(await defaultStore.read()).toEqual(["current"]);
    expect(await alternateStore.read()).toEqual(["alternate"]);
  });

  it("reads version-one records and accepts later updates with matching timestamps", async () => {
    // Arrange
    mkdirSync(path.dirname(recordPath()), { recursive: true });
    writeFileSync(
      recordPath(),
      JSON.stringify({ failedTasks: ["legacy"], version: 1 }),
    );
    const store = createFailedTaskStore(fixture.root);

    // Act
    const initial = await store.read();
    await store.write(["tie-lower"], 123, "a-run");
    await store.write(["tie-higher"], 123, "z-run");

    // Assert
    expect(initial).toEqual(["legacy"]);
    expect(await store.read()).toEqual(["tie-higher"]);
  });

  it("starts empty and atomically replaces failures with unique task IDs", async () => {
    // Arrange
    const store = createFailedTaskStore(fixture.root);

    // Act
    const initial = await store.read();
    await store.write(["apps/web#test", "apps/web#test", "lint"], 123, "run-1");

    // Assert
    expect(initial).toEqual([]);
    expect(await store.read()).toEqual(["apps/web#test", "lint"]);
    const record: unknown = JSON.parse(readFileSync(recordPath(), "utf8"));
    expect(record).toEqual({
      completedAt: 123,
      failedTasks: ["apps/web#test", "lint"],
      runId: "run-1",
      version: 2,
    });
  });

  it.each([
    "{",
    "null",
    JSON.stringify({ failedTasks: [], version: 2 }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ failedTasks: "test", version: 1 }),
    JSON.stringify({ failedTasks: [1], version: 1 }),
    JSON.stringify({ failedTasks: [""], version: 1 }),
  ])("rejects malformed state %s", async (source) => {
    // Arrange
    mkdirSync(path.dirname(recordPath()), { recursive: true });
    writeFileSync(recordPath(), source);

    // Act & Assert
    await expect(createFailedTaskStore(fixture.root).read()).rejects.toThrow(
      "Invalid failed-task record",
    );
  });

  it("propagates filesystem errors that do not mean the record is missing", async () => {
    // Arrange
    const store = createFailedTaskStore(`${fixture.root}\0`);

    // Act & Assert
    await expect(store.read()).rejects.toMatchObject({
      code: "ERR_INVALID_ARG_VALUE",
    });
  });

  it("rejects invalid completion metadata before writing", async () => {
    // Arrange
    const store = createFailedTaskStore(fixture.root);

    // Act & Assert
    await expect(store.write([], NaN, "run")).rejects.toThrow(
      "completion time",
    );
    await expect(store.write([], 123, "")).rejects.toThrow("run ID");
  });

  it("removes a temporary file when replacing the record fails", async () => {
    // Arrange
    const file = recordPath();
    mkdirSync(path.dirname(file), { recursive: true });
    mkdirSync(file);

    // Act & Assert
    await expect(
      createFailedTaskStore(fixture.root).write(["test"]),
    ).rejects.toThrow();
    expect(
      readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});
