import { cpus, freemem, totalmem } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { monitorHostResources } from "./host-resources";

vi.mock(import("node:os"), async (importOriginal) => ({
  ...(await importOriginal()),
  cpus: vi.fn(),
  freemem: vi.fn(),
  totalmem: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("host resource evidence", () => {
  it("bounds recent samples while retaining lifetime pressure peaks and stopping its timer", () => {
    // Arrange
    vi.useFakeTimers();
    let tick = 0;
    vi.mocked(cpus).mockImplementation(() => {
      tick++;
      return [
        {
          model: "fixture",
          speed: 1000,
          times: { idle: tick * 20, irq: 0, nice: 0, sys: 0, user: tick * 80 },
        },
      ];
    });
    vi.mocked(totalmem).mockReturnValue(1000);
    vi.mocked(freemem).mockReturnValueOnce(50).mockReturnValue(500);
    const finish = monitorHostResources();

    // Act
    vi.advanceTimersByTime(15_000);
    const evidence = finish();
    vi.advanceTimersByTime(5000);

    // Assert
    expect(evidence).toMatchObject({
      minFreeMemoryBytes: 50,
      peakCpuPercent: 80,
      sampleCount: 17,
      sampleIntervalMs: 1000,
      totalMemoryBytes: 1000,
    });
    expect(evidence.samples).toHaveLength(10);
    expect(evidence.samples.every((sample) => sample.cpuPercent === 80)).toBe(
      true,
    );
    expect(cpus).toHaveBeenCalledTimes(17);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not invent CPU utilization when CPU counters are unavailable", () => {
    // Arrange
    vi.mocked(cpus).mockReturnValue([]);
    vi.mocked(freemem).mockReturnValue(500);
    vi.mocked(totalmem).mockReturnValue(1000);

    // Act
    const evidence = monitorHostResources()();

    // Assert
    expect(evidence.sampleCount).toBe(2);
    expect(evidence).not.toHaveProperty("peakCpuPercent");
    expect(evidence.samples[0]).not.toHaveProperty("cpuPercent");
  });

  it("records sampling failures without throwing away the command's outcome", () => {
    // Arrange
    vi.mocked(cpus).mockImplementation(() => {
      throw new Error("host counters unavailable");
    });

    // Act
    const evidence = monitorHostResources()();

    // Assert
    expect(evidence).toMatchObject({
      error: "host counters unavailable",
      sampleCount: 0,
      samples: [],
    });
    expect(evidence).not.toHaveProperty("totalMemoryBytes");
  });
});
