import { availableParallelism, cpus, freemem } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { restoreTestPlatform, setTestPlatform, setupHost } from "./__tests__";
import { createAutoConcurrencyController } from "./auto-concurrency";

vi.mock(import("node:fs"), async (importOriginal) => ({
  ...(await importOriginal()),
  readFileSync: vi.fn(),
}));
vi.mock(import("node:os"), async (importOriginal) => ({
  ...(await importOriginal()),
  availableParallelism: vi.fn(),
  cpus: vi.fn(),
  freemem: vi.fn(),
  totalmem: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  setTestPlatform("win32");
  setupHost();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  restoreTestPlatform();
});

describe("automatic concurrency", () => {
  it("starts at one, ramps up after healthy samples, wakes waiters, and stops", async () => {
    // Arrange
    const controller = createAutoConcurrencyController();
    expect(controller).toBeDefined();
    if (controller === undefined) throw new Error("Expected a controller");
    const changed = controller.waitForChange(0);

    // Act
    await vi.advanceTimersByTimeAsync(2000);
    await changed;

    // Assert
    expect(controller).toMatchObject({
      currentConcurrency: 2,
      maxConcurrency: 4,
      revision: 1,
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(controller.currentConcurrency).toBe(4);
    expect(controller.revision).toBe(3);
    controller.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reduces the limit under memory pressure and never falls below one", async () => {
    // Arrange
    const host = setupHost();
    const controller = createAutoConcurrencyController();
    expect(controller).toBeDefined();
    if (controller === undefined) throw new Error("Expected a controller");
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.currentConcurrency).toBe(2);
    const changed = controller.waitForChange(controller.revision);
    host.setFreeMemory(100);

    // Act
    await vi.advanceTimersByTimeAsync(1000);
    await changed;
    await vi.advanceTimersByTimeAsync(1000);

    // Assert
    expect(controller).toMatchObject({ currentConcurrency: 1, revision: 2 });
    controller.close();
  });

  it("clears a partial healthy streak when CPU is busy and caps growth", async () => {
    // Arrange
    const host = setupHost();
    const controller = createAutoConcurrencyController();
    expect(controller).toBeDefined();
    if (controller === undefined) throw new Error("Expected a controller");
    await vi.advanceTimersByTimeAsync(1000);
    host.setCpuUsage(80);

    // Act
    await vi.advanceTimersByTimeAsync(1000);
    host.setCpuUsage(70);
    await vi.advanceTimersByTimeAsync(2000);

    // Assert
    expect(controller.currentConcurrency).toBe(2);
    expect(controller.revision).toBe(1);
    controller.close();
  });

  it("resolves stale, aborted, and closed change waits", async () => {
    // Arrange
    const controller = createAutoConcurrencyController();
    expect(controller).toBeDefined();
    if (controller === undefined) throw new Error("Expected a controller");
    const abort = new AbortController();
    abort.abort();

    // Act & Assert
    await expect(controller.waitForChange(1)).resolves.toBeUndefined();
    await expect(
      controller.waitForChange(0, abort.signal),
    ).resolves.toBeUndefined();
    const waiting = controller.waitForChange(0);
    controller.close();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
    controller.close();
  });

  it.each([
    { label: "no CPU entries", settings: { cpuCount: 0 } },
    { label: "invalid total memory", settings: { totalMemory: NaN } },
    { label: "no total memory", settings: { totalMemory: 0 } },
    { label: "invalid free memory", settings: { freeMemory: NaN } },
  ])(
    "falls back when startup resources are invalid: $label",
    ({ settings }) => {
      // Arrange
      setupHost(settings);

      // Act & Assert
      expect(createAutoConcurrencyController()).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("uses host CPU count when availableParallelism is invalid or unavailable", () => {
    // Arrange
    vi.mocked(availableParallelism).mockReturnValue(0);

    // Act
    const invalid = createAutoConcurrencyController();

    // Assert
    expect(invalid?.maxConcurrency).toBe(4);
    invalid?.close();
    vi.mocked(availableParallelism).mockImplementation(() => {
      throw new Error("unavailable");
    });
    const unavailable = createAutoConcurrencyController();
    expect(unavailable?.maxConcurrency).toBe(4);
    unavailable?.close();
  });

  it("returns no controller when the first resource sample fails", () => {
    // Arrange
    vi.mocked(freemem).mockReturnValueOnce(500).mockReturnValueOnce(NaN);

    // Act & Assert
    expect(createAutoConcurrencyController()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores invalid periodic samples and bounds reported memory headroom", async () => {
    // Arrange
    const host = setupHost();
    const controller = createAutoConcurrencyController();
    expect(controller).toBeDefined();
    if (controller === undefined) throw new Error("Expected a controller");
    vi.mocked(freemem).mockReturnValueOnce(NaN);
    host.setFreeMemory(2000);

    // Act
    await vi.advanceTimersByTimeAsync(3000);

    // Assert
    expect(controller.currentConcurrency).toBe(2);
    controller.close();
  });

  it("uses host resources outside Linux and rejects invalid CPU snapshots", () => {
    // Arrange
    const host = setupHost({ available: 2, cpuCount: 2 });
    vi.mocked(cpus)
      .mockReturnValueOnce([
        {
          model: "fixture",
          speed: 1000,
          times: { idle: 100, irq: 0, nice: 0, sys: 0, user: 100 },
        },
        {
          model: "fixture",
          speed: 1000,
          times: { idle: 100, irq: 0, nice: 0, sys: 0, user: 100 },
        },
      ])
      .mockReturnValueOnce([
        {
          model: "fixture",
          speed: 1000,
          times: { idle: 100, irq: 0, nice: 0, sys: 0, user: 100 },
        },
        {
          model: "fixture",
          speed: 1000,
          times: { idle: 100, irq: 0, nice: 0, sys: 0, user: 100 },
        },
      ]);

    // Act
    const controller = createAutoConcurrencyController();
    host.setFreeMemory(-1);

    // Assert
    expect(controller?.maxConcurrency).toBe(2);
    expect(controller?.currentConcurrency).toBe(1);
    controller?.close();
  });
});
