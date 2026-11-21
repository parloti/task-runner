import { availableParallelism, cpus, freemem, totalmem } from "node:os";

import type { ConcurrencyController } from "../application";

import { readCgroupMemory } from "./cgroup-limits";
import { readCgroupResources } from "./cgroup-resources";

const sampleIntervalMs = 1000;
const healthyCpuPercent = 70;
const healthyMemoryPercent = 25;
const pressuredMemoryPercent = 15;
const healthySamplesToIncrease = 2;

interface CpuTotals {
  readonly idle: number;
  readonly total: number;
}

interface ManagedConcurrencyController extends ConcurrencyController {
  close(): void;
}

interface ResourceReader {
  readonly maxConcurrency: number;
  read(): ResourceSample | undefined;
}

interface ResourceSample {
  readonly cpuPercent?: number;
  readonly memoryPercent: number;
}

class AdaptiveConcurrencyController implements ManagedConcurrencyController {
  get currentConcurrency(): number {
    return this.currentLimit;
  }

  get maxConcurrency(): number {
    return this.reader.maxConcurrency;
  }

  get revision(): number {
    return this.currentRevision;
  }

  private closed = false;
  private currentLimit = 1;
  private currentRevision = 0;
  private healthySamples = 0;
  private readonly timer: NodeJS.Timeout;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly reader: ResourceReader) {
    this.timer = setInterval(() => {
      this.sample();
    }, sampleIntervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.resolveWaiters();
  }

  waitForChange(revision: number, signal?: AbortSignal): Promise<void> {
    if (revision !== this.currentRevision || this.closed || signal?.aborted)
      return Promise.resolve();
    return new Promise((resolve) => {
      const finish = (): void => {
        this.waiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      this.waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  private resolveWaiters(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  private sample(): void {
    if (this.closed) return;
    const reading = this.reader.read();
    if (reading === undefined) return;
    if (reading.memoryPercent <= pressuredMemoryPercent) {
      this.healthySamples = 0;
      this.setLimit(this.currentLimit - 1);
      return;
    }
    const healthy =
      reading.cpuPercent !== undefined &&
      reading.cpuPercent <= healthyCpuPercent &&
      reading.memoryPercent >= healthyMemoryPercent;
    if (!healthy) {
      this.healthySamples = 0;
      return;
    }
    this.healthySamples++;
    if (this.healthySamples < healthySamplesToIncrease) return;
    this.healthySamples = 0;
    this.setLimit(this.currentLimit + 1);
  }

  private setLimit(limit: number): void {
    const next = Math.max(1, Math.min(this.reader.maxConcurrency, limit));
    if (next === this.currentLimit) return;
    this.currentLimit = next;
    this.currentRevision++;
    this.resolveWaiters();
  }
}

/**
 * Start a run-scoped adaptive command limit, or return undefined when host
 * resource sampling is unavailable so the caller can use its static fallback.
 * @returns Managed adaptive limit, or undefined if startup sampling is unavailable.
 * @example `const limit = createAutoConcurrencyController()` starts adaptive sampling.
 */
export function createAutoConcurrencyController():
  ManagedConcurrencyController | undefined {
  const reader = createResourceReader();
  if (reader?.read() === undefined) return;
  return new AdaptiveConcurrencyController(reader);
}

/**
 * Calculate CPU use relative to the effective command limit.
 * @param previous Previous cumulative CPU counters.
 * @param current Current cumulative CPU counters.
 * @param hostCpuCount Number of host logical CPUs.
 * @param effectiveCpuCount Effective concurrency allowed for this process.
 * @returns Bounded CPU utilization percentage, or undefined for invalid snapshots.
 * @example `calculateCpuPercent(before, after, 8, 2)` scales host usage to two CPUs.
 */
function calculateCpuPercent(
  previous: CpuTotals,
  current: CpuTotals,
  hostCpuCount: number,
  effectiveCpuCount: number,
): number | undefined {
  const elapsed = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (elapsed <= 0 || !Number.isFinite(elapsed) || idle < 0) return;
  const hostPercent = Math.max(0, Math.min(100, (1 - idle / elapsed) * 100));
  return Math.max(
    0,
    Math.min(100, hostPercent * (hostCpuCount / effectiveCpuCount)),
  );
}

/**
 * Read logical CPU totals and sum idle and total time.
 * @param entries Host CPU snapshots from `node:os`.
 * @returns Cumulative idle and total CPU counters.
 * @example `cpuTotals(cpus())` provides counters for utilization sampling.
 */
function cpuTotals(entries: ReturnType<typeof cpus>): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const entry of entries)
    for (const [name, value] of Object.entries(entry.times)) {
      total += value;
      if (name === "idle") idle += value;
    }
  return { idle, total };
}

/**
 * Create a resource reader when startup host measurements are valid.
 * @returns Resource sampler and effective CPU ceiling, or undefined when sampling cannot start.
 * @example `createResourceReader()` selects host and cgroup resource limits.
 */
function createResourceReader(): ResourceReader | undefined {
  try {
    const initialCpus = cpus();
    const hostCpuCount = initialCpus.length;
    const hostMemory = totalmem();
    const initialFreeMemory = freemem();
    if (
      hostCpuCount < 1 ||
      !Number.isFinite(hostMemory) ||
      hostMemory <= 0 ||
      !Number.isFinite(initialFreeMemory)
    )
      return;

    const cgroup = readCgroupResources();
    const quotaLimit =
      cgroup.cpuLimit === undefined ? Infinity : Math.ceil(cgroup.cpuLimit);
    const cpusetLimit = cgroup.cpusetLimit ?? Infinity;
    const osLimit = safeAvailableParallelism(hostCpuCount);
    const maxConcurrency = Math.max(
      1,
      Math.min(hostCpuCount, osLimit, quotaLimit, cpusetLimit),
    );
    let previousCpu = cpuTotals(initialCpus);

    return {
      maxConcurrency,
      read: () => {
        try {
          const currentCpus = cpus();
          const currentCpu = cpuTotals(currentCpus);
          const cpuPercent = calculateCpuPercent(
            previousCpu,
            currentCpu,
            hostCpuCount,
            maxConcurrency,
          );
          previousCpu = currentCpu;

          const currentFreeMemory = freemem();
          const currentTotalMemory = totalmem();
          if (
            !Number.isFinite(currentFreeMemory) ||
            !Number.isFinite(currentTotalMemory) ||
            currentTotalMemory <= 0
          )
            return;
          const cgroupMemory = readCgroupMemory(cgroup);
          const effectiveMemory =
            cgroupMemory === undefined
              ? { free: currentFreeMemory, total: currentTotalMemory }
              : {
                  free: Math.min(currentFreeMemory, cgroupMemory.free),
                  total: Math.min(currentTotalMemory, cgroupMemory.total),
                };
          if (effectiveMemory.total <= 0) return;
          return {
            ...(cpuPercent !== undefined && { cpuPercent }),
            memoryPercent: Math.max(
              0,
              Math.min(
                100,
                (effectiveMemory.free / effectiveMemory.total) * 100,
              ),
            ),
          };
        } catch {
          return;
        }
      },
    };
  } catch {
    return;
  }
}

/**
 * Use Node's available parallelism count when it returns a valid value.
 * @param fallback Host CPU count to use when the API is unavailable.
 * @returns Positive available parallelism count or the fallback.
 * @example `safeAvailableParallelism(8)` returns the host count if Node cannot report one.
 */
function safeAvailableParallelism(fallback: number): number {
  try {
    const count = availableParallelism();
    return Number.isSafeInteger(count) && count > 0 ? count : fallback;
  } catch {
    return fallback;
  }
}
