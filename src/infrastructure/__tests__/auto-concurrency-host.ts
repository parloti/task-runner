import { readFileSync } from "node:fs";
import { availableParallelism, cpus, freemem, totalmem } from "node:os";
import { vi } from "vitest";

const originalPlatform = process.platform;

interface HostFixture {
  readonly files: Map<string, string>;
  setCpuUsage(value: number): void;
  setFreeMemory(value: number): void;
}

interface HostSettings {
  readonly available?: number;
  readonly cpuCount?: number;
  readonly cpuUsage?: number;
  readonly files?: Readonly<Record<string, string>>;
  readonly freeMemory?: number;
  readonly totalMemory?: number;
}

/**
 * Restore `process.platform` after a resource-reader test.
 * @example `restoreTestPlatform()` restores the original platform.
 */
export function restoreTestPlatform(): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
}

/**
 * Set the platform value used by resource-reader tests.
 * @param platform Platform name to expose through `process.platform`.
 * @example `setTestPlatform("linux")` enables cgroup fixture paths.
 */
export function setTestPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

/**
 * Configure deterministic CPU, memory, and cgroup samples.
 * @param settings Optional host values and virtual file contents.
 * @returns The virtual file map and controls for changing resource samples.
 * @example `const host = setupHost({ cpuCount: 4 })` creates four CPU fixtures.
 */
export function setupHost(settings: HostSettings = {}): HostFixture {
  const cpuCount = settings.cpuCount ?? 4;
  let cpuUsage = settings.cpuUsage ?? 50;
  let freeMemory = settings.freeMemory ?? 500;
  let tick = 0;
  const files = new Map(Object.entries(settings.files ?? {}));
  vi.mocked(availableParallelism).mockReturnValue(settings.available ?? 4);
  vi.mocked(cpus).mockImplementation(() => {
    tick++;
    return Array.from({ length: cpuCount }, () => ({
      model: "fixture",
      speed: 1000,
      times: {
        idle: tick * (100 - cpuUsage),
        irq: 0,
        nice: 0,
        sys: 0,
        user: tick * cpuUsage,
      },
    }));
  });
  vi.mocked(freemem).mockImplementation(() => freeMemory);
  vi.mocked(totalmem).mockReturnValue(settings.totalMemory ?? 1000);
  vi.mocked(readFileSync).mockImplementation((file) => {
    const contents = files.get(String(file));
    if (contents === undefined)
      throw new Error(`Missing fixture: ${String(file)}`);
    return contents;
  });
  return {
    files,
    setCpuUsage(value) {
      cpuUsage = value;
    },
    setFreeMemory(value) {
      freeMemory = value;
    },
  };
}
