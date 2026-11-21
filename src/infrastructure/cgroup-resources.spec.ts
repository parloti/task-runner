import { readFileSync } from "node:fs";
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
  setTestPlatform("linux");
  setupHost();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  restoreTestPlatform();
});

describe("cgroup resource limits", () => {
  it("uses cgroup v2 quota, cpusets, escaped mount paths, and memory limits", async () => {
    // Arrange
    const host = setupHost({
      available: 8,
      cpuCount: 8,
      files: {
        "/proc/self/cgroup": "0::/tenant group/job\n",
        "/proc/self/mountinfo":
          "29 23 0:26 /tenant\\040group /sys/fs/cgroup/my\\040group rw - cgroup2 cgroup rw\n",
        "/sys/fs/cgroup/my group/cpu.max": "max 100000",
        "/sys/fs/cgroup/my group/job/cpu.max": "150000 100000",
        "/sys/fs/cgroup/my group/job/cpuset.cpus.effective": "0-2,4",
        "/sys/fs/cgroup/my group/job/memory.current": "700",
        "/sys/fs/cgroup/my group/job/memory.max": "1000",
        "/sys/fs/cgroup/my group/memory.current": "1000",
        "/sys/fs/cgroup/my group/memory.max": "1200",
      },
    });
    const controller = createAutoConcurrencyController();

    // Act
    await vi.advanceTimersByTimeAsync(3000);

    // Assert
    expect(controller).toMatchObject({
      currentConcurrency: 1,
      maxConcurrency: 2,
    });
    expect(host.files.has("/sys/fs/cgroup/my group/job/cpu.max")).toBe(true);
    controller?.close();
  });

  it("intersects inherited cgroup v2 CPU sets and ignores malformed entries", () => {
    // Arrange
    const host = setupHost({
      available: 8,
      cpuCount: 8,
      files: {
        "/proc/self/cgroup": "bad\n0::/tenant/job\n2:cpu:/legacy/job\n",
        "/proc/self/mountinfo":
          "bad mount\n29 23 0:26 /tenant /sys/fs/cgroup rw - cgroup2 cgroup\n",
        "/sys/fs/cgroup/cpu.max": "max 100000",
        "/sys/fs/cgroup/cpuset.cpus": "0-7",
        "/sys/fs/cgroup/job/cpu.max": "200000 100000",
        "/sys/fs/cgroup/job/cpuset.cpus": "bad",
        "/sys/fs/cgroup/job/cpuset.cpus.effective": "invalid",
        "/sys/fs/cgroup/job/memory.max": "max",
        "/sys/fs/cgroup/memory.max": "-1",
      },
    });

    // Act
    const controller = createAutoConcurrencyController();

    // Assert
    expect(controller?.maxConcurrency).toBe(2);
    expect(host.files.has("/sys/fs/cgroup/cpuset.cpus")).toBe(true);
    controller?.close();
  });

  it("applies cgroup v1 quotas, inherited CPU sets, and memory limits", () => {
    // Arrange
    setupHost({
      available: 8,
      cpuCount: 8,
      files: {
        "/proc/self/cgroup":
          "5:cpu,cpuacct:/tenant/job\n6:cpuset:/tenant/job\n7:memory:/tenant/job\n",
        "/proc/self/mountinfo": [
          "29 23 0:26 /tenant /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu,cpuacct",
          "30 23 0:27 /tenant /sys/fs/cgroup/cpuset rw - cgroup cgroup rw,cpuset",
          "31 23 0:28 /tenant /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory",
        ].join("\n"),
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "500000",
        "/sys/fs/cgroup/cpu/job/cpu.cfs_period_us": "100000",
        "/sys/fs/cgroup/cpu/job/cpu.cfs_quota_us": "200000",
        "/sys/fs/cgroup/cpuset/cpuset.cpus": "1-8",
        "/sys/fs/cgroup/cpuset/job/cpuset.cpus": "2-5",
        "/sys/fs/cgroup/memory/job/memory.limit_in_bytes": "1000",
        "/sys/fs/cgroup/memory/job/memory.usage_in_bytes": "500",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2000",
        "/sys/fs/cgroup/memory/memory.usage_in_bytes": "100",
      },
    });

    // Act
    const controller = createAutoConcurrencyController();

    // Assert
    expect(controller?.maxConcurrency).toBe(2);
    controller?.close();
  });

  it("falls back to host limits when cgroup metadata cannot be read", () => {
    // Arrange
    setupHost({ available: 3, cpuCount: 8 });
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("cgroups unavailable");
    });

    // Act
    const controller = createAutoConcurrencyController();

    // Assert
    expect(controller?.maxConcurrency).toBe(3);
    controller?.close();
  });

  it("falls back when cgroup paths do not belong to their mounted roots", () => {
    // Arrange
    setupHost({
      available: 6,
      cpuCount: 8,
      files: {
        "/proc/self/cgroup": "0::/other/job\n",
        "/proc/self/mountinfo":
          "29 23 0:26 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
      },
    });

    // Act
    const controller = createAutoConcurrencyController();

    // Assert
    expect(controller?.maxConcurrency).toBe(6);
    controller?.close();
  });

  it("falls back when unified cgroup membership has no matching mount", () => {
    // Arrange
    setupHost({
      available: 6,
      cpuCount: 8,
      files: {
        "/proc/self/cgroup": "0::/tenant/job\n",
        "/proc/self/mountinfo":
          "29 23 0:26 /tenant /sys/fs/cgroup rw - cgroup cgroup rw,cpu\n",
      },
    });

    // Act
    const controller = createAutoConcurrencyController();

    // Assert
    expect(controller?.maxConcurrency).toBe(6);
    controller?.close();
  });

  it("accepts valid CPU sets while ignoring invalid and unlimited cgroup quotas", () => {
    // Arrange
    setupHost({
      available: 8,
      cpuCount: 8,
      files: {
        "/proc/self/cgroup": "0::/tenant/job\n",
        "/proc/self/mountinfo":
          "29 23 0:26 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
        "/sys/fs/cgroup/cpu.max": "max 100000",
        "/sys/fs/cgroup/job/cpu.max": "invalid",
        "/sys/fs/cgroup/job/cpuset.cpus.effective": "0-1,1-3,8",
        "/sys/fs/cgroup/job/memory.current": "invalid",
        "/sys/fs/cgroup/job/memory.max": "1000",
      },
    });

    // Act
    const controller = createAutoConcurrencyController();

    // Assert
    expect(controller?.maxConcurrency).toBe(5);
    controller?.close();
  });
});
