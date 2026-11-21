import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  CgroupResources,
  CpuRange,
  MemoryConstraint,
  MemoryReading,
} from "./cgroup-types";

/**
 * Return the minimum available numeric constraint.
 * @param values Candidate constraints; undefined values are ignored.
 * @returns Smallest available value, or undefined when none are present.
 * @example `minimum([4, undefined, 2])` returns `2`.
 */
export function minimum(
  values: readonly (number | undefined)[],
): number | undefined {
  const present = values.filter(
    (value): value is number => value !== undefined,
  );
  return present.length === 0 ? undefined : Math.min(...present);
}

/**
 * Read the effective memory headroom allowed by cgroup constraints.
 * @param cgroup Resource constraints collected from the cgroup hierarchy.
 * @returns Effective free and total memory, or undefined when no current usage is available.
 * @example `readCgroupMemory(cgroup)` returns the tightest current memory limit.
 */
export function readCgroupMemory(
  cgroup: CgroupResources,
): MemoryReading | undefined {
  const constraints = cgroup.memoryConstraints;
  if (constraints === undefined || constraints.length === 0) return undefined;
  let free = Infinity;
  let total = Infinity;
  let found = false;
  for (const constraint of constraints) {
    try {
      const current = Number(
        readFileSync(constraint.currentPath, "utf8").trim(),
      );
      if (!Number.isFinite(current) || current < 0) continue;
      free = Math.min(free, Math.max(0, constraint.limit - current));
      total = Math.min(total, constraint.limit);
      found = true;
    } catch {
      continue;
    }
  }
  return found ? { free, total } : undefined;
}

/**
 * Read the CPU quota from cgroup v1 quota and period files.
 * @param directory Directory containing the quota files.
 * @returns The quota in CPUs, or undefined for unlimited or invalid values.
 * @example `readCpuLimitV1("/sys/fs/cgroup/cpu")` reads the CPU quota.
 */
export function readCpuLimitV1(directory: string): number | undefined {
  try {
    const quota = Number(
      readFileSync(
        path.posix.join(directory, "cpu.cfs_quota_us"),
        "utf8",
      ).trim(),
    );
    const period = Number(
      readFileSync(
        path.posix.join(directory, "cpu.cfs_period_us"),
        "utf8",
      ).trim(),
    );
    return quota < 0 ? undefined : positiveRatio(quota, period);
  } catch {
    return undefined;
  }
}

/**
 * Read the CPU quota from a cgroup v2 `cpu.max` file.
 * @param file Path to the quota file.
 * @returns The quota in CPUs, or undefined for unlimited or invalid values.
 * @example `readCpuLimitV2("/sys/fs/cgroup/cpu.max")` reads the current quota.
 */
export function readCpuLimitV2(file: string): number | undefined {
  try {
    const [quota, period] = readFileSync(file, "utf8").trim().split(/\s+/u, 2);
    return quota === undefined || quota === "max" || period === undefined
      ? undefined
      : positiveRatio(Number(quota), Number(period));
  } catch {
    return undefined;
  }
}

/**
 * Read the number of CPUs listed by a cpuset file.
 * @param file Path to the cpuset file.
 * @returns Number of CPUs, or undefined for unavailable or invalid data.
 * @example `readCpusetLimit("/sys/fs/cgroup/cpuset.cpus.effective")` counts the effective CPUs.
 */
export function readCpusetLimit(file: string): number | undefined {
  try {
    return countCpuset(parseCpuset(readFileSync(file, "utf8").trim()));
  } catch {
    return undefined;
  }
}

/**
 * Intersect inherited cgroup CPU sets and return their effective size.
 * @param directories Current cgroup directory followed by its ancestors.
 * @returns Number of CPUs in the intersection, or undefined when no valid set exists.
 * @example `readInheritedCpusetLimit(["/sys/fs/cgroup/job", "/sys/fs/cgroup"])` checks both levels.
 */
export function readInheritedCpusetLimit(
  directories: readonly string[],
): number | undefined {
  let effective: CpuRange[] | undefined;
  for (const directory of directories) {
    let current: CpuRange[] | undefined;
    try {
      current = parseCpuset(
        readFileSync(path.posix.join(directory, "cpuset.cpus"), "utf8").trim(),
      );
    } catch {
      continue;
    }
    if (current === undefined) continue;
    effective =
      effective === undefined ? current : intersectCpusets(effective, current);
  }
  return countCpuset(effective);
}

/**
 * Pair a valid memory limit with its current-usage path.
 * @param limitPath Path to the memory limit file.
 * @param currentPath Path to the current memory usage file.
 * @returns The constraint, or undefined for an unlimited or invalid limit.
 * @example `readMemoryConstraint("memory.max", "memory.current")` records a v2 limit.
 */
export function readMemoryConstraint(
  limitPath: string,
  currentPath: string,
): MemoryConstraint | undefined {
  const limit = readMemoryLimit(limitPath);
  return limit === undefined ? undefined : { currentPath, limit };
}

/**
 * Count the CPUs represented by a set of ranges.
 * @param ranges Normalized CPU ranges.
 * @returns Number of CPUs, or undefined when the set is empty or invalid.
 * @example `countCpuset([{ first: 0, last: 3 }])` returns 4.
 */
function countCpuset(
  ranges: readonly CpuRange[] | undefined,
): number | undefined {
  if (ranges === undefined) return undefined;
  let count = 0;
  for (const range of ranges) count += range.last - range.first + 1;
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

/**
 * Intersect two sorted CPU range lists.
 * @param left First sorted CPU range list.
 * @param right Second sorted CPU range list.
 * @returns Sorted ranges containing only CPUs present in both lists.
 * @example `intersectCpusets([{ first: 0, last: 3 }], [{ first: 2, last: 4 }])` returns CPUs 2 and 3.
 */
function intersectCpusets(
  left: readonly CpuRange[],
  right: readonly CpuRange[],
): CpuRange[] {
  const intersection: CpuRange[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftRange = left[leftIndex];
    const rightRange = right[rightIndex];
    if (leftRange === undefined || rightRange === undefined) break;
    const first = Math.max(leftRange.first, rightRange.first);
    const last = Math.min(leftRange.last, rightRange.last);
    if (first <= last) intersection.push({ first, last });
    if (leftRange.last < rightRange.last) leftIndex++;
    else rightIndex++;
  }
  return intersection;
}

/**
 * Parse and merge comma-separated CPU numbers and ranges.
 * @param value CPU numbers such as `0-2,4`.
 * @returns Sorted, merged ranges, or undefined for invalid or empty input.
 * @example `parseCpuset("0-2,4")` returns ranges for CPUs 0 through 2 and CPU 4.
 */
function parseCpuset(value: string): CpuRange[] | undefined {
  if (value === "") return undefined;
  const ranges: CpuRange[] = [];
  for (const range of value.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(range);
    if (match === null) return undefined;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start
    )
      return undefined;
    ranges.push({ first: start, last: end });
  }

  const merged: CpuRange[] = [];
  const sortedRanges = ranges.toSorted(
    (left, right) => left.first - right.first,
  );
  for (const current of sortedRanges) {
    const previous = merged.at(-1);
    if (previous === undefined || current.first > previous.last + 1)
      merged.push(current);
    else
      merged[merged.length - 1] = {
        first: previous.first,
        last: Math.max(previous.last, current.last),
      };
  }
  return merged;
}

/**
 * Divide positive finite resource values.
 * @param numerator Value to divide.
 * @param denominator Positive divisor.
 * @returns Positive finite ratio, or undefined for invalid values.
 * @example `positiveRatio(150000, 100000)` returns `1.5`.
 */
function positiveRatio(
  numerator: number,
  denominator: number,
): number | undefined {
  return !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
    ? undefined
    : numerator / denominator;
}

/**
 * Read a positive memory limit, treating `max` as unlimited.
 * @param file Path to the memory limit file.
 * @returns The positive limit in bytes, or undefined for unlimited or invalid values.
 * @example `readMemoryLimit("/sys/fs/cgroup/memory.max")` reads a v2 limit.
 */
function readMemoryLimit(file: string): number | undefined {
  try {
    const value = readFileSync(file, "utf8").trim();
    if (value === "max") return undefined;
    const limit = Number(value);
    return !Number.isFinite(limit) || limit <= 0 ? undefined : limit;
  } catch {
    return undefined;
  }
}
