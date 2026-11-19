import { cpus, freemem, totalmem } from "node:os";

import type { HostResourceSample, HostResourceUsage } from "../domain";

import { normalizeExecutionError } from "../domain";

const sampleIntervalMs = 1000;
const retainedSamples = 10;

interface CpuTotals {
  readonly idle: number;
  readonly total: number;
}

/**
 * Sample host-wide resource pressure until the owned command settles.
 * @returns A completion function that stops sampling and returns bounded evidence.
 * @example `const finish = monitorHostResources(); const usage = finish();`
 */
export function monitorHostResources(): () => HostResourceUsage {
  const samples: HostResourceSample[] = [];
  let previousCpu: ReturnType<typeof cpuTotals> | undefined;
  let minFreeMemoryBytes: number | undefined;
  let peakCpuPercent: number | undefined;
  let totalMemoryBytes: number | undefined;
  let sampleCount = 0;
  let samplingError: string | undefined;
  const sample = (): void => {
    try {
      const currentCpu = cpuTotals();
      const elapsed =
        currentCpu.total - (previousCpu?.total ?? currentCpu.total);
      const idle = currentCpu.idle - (previousCpu?.idle ?? currentCpu.idle);
      const cpuPercent =
        elapsed > 0
          ? Math.max(0, Math.min(100, (1 - idle / elapsed) * 100))
          : undefined;
      const freeMemoryBytes = freemem();
      totalMemoryBytes = totalmem();
      previousCpu = currentCpu;
      minFreeMemoryBytes = Math.min(
        minFreeMemoryBytes ?? freeMemoryBytes,
        freeMemoryBytes,
      );
      if (cpuPercent !== undefined)
        peakCpuPercent = Math.max(peakCpuPercent ?? cpuPercent, cpuPercent);
      sampleCount++;
      samples.push({
        freeMemoryBytes,
        timestamp: new Date().toISOString(),
        ...(cpuPercent !== undefined && { cpuPercent }),
      });
      if (samples.length > retainedSamples) samples.shift();
    } catch (error) {
      samplingError = normalizeExecutionError(error).message;
    }
  };
  sample();
  const timer = setInterval(sample, sampleIntervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    sample();
    return {
      sampleCount,
      sampleIntervalMs,
      samples,
      ...(totalMemoryBytes !== undefined && { totalMemoryBytes }),
      ...(minFreeMemoryBytes !== undefined && { minFreeMemoryBytes }),
      ...(peakCpuPercent !== undefined && { peakCpuPercent }),
      ...(samplingError !== undefined && { error: samplingError }),
    };
  };
}

/**
 * Read cumulative CPU times across every logical CPU, in milliseconds.
 * @returns Host-wide idle and total CPU times.
 * @example `cpuTotals()` supplies counters for utilization deltas.
 */
function cpuTotals(): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    for (const time of Object.values(cpu.times)) total += time;
  }
  return { idle, total };
}
