import { readFileSync } from "node:fs";
import path from "node:path";

import type { CgroupResources, MemoryConstraint } from "./cgroup-types";

import {
  minimum,
  readCpuLimitV1,
  readCpuLimitV2,
  readCpusetLimit,
  readInheritedCpusetLimit,
  readMemoryConstraint,
} from "./cgroup-limits";
import {
  ancestorDirectories,
  readCgroupMemberships,
  readCgroupMounts,
  resolveCgroupDirectory,
  resolveV1Controller,
} from "./cgroup-metadata";

/**
 * Read CPU and memory constraints from cgroup v1 or v2.
 * @returns Effective limits discovered from the current process hierarchy.
 * @example `readCgroupResources()` reads the active Linux cgroup limits.
 */
export function readCgroupResources(): CgroupResources {
  if (process.platform !== "linux") return {};
  try {
    const memberships = readCgroupMemberships(
      readFileSync("/proc/self/cgroup", "utf8"),
    );
    const mounts = readCgroupMounts(
      readFileSync("/proc/self/mountinfo", "utf8"),
    );
    let unifiedResources: CgroupResources = {};
    const unified = memberships.find((entry) => entry.controllers.length === 0);
    if (unified !== undefined) {
      const mount = mounts.find((entry) => entry.type === "cgroup2");
      if (mount !== undefined) {
        const directory = resolveCgroupDirectory(mount, unified.path);
        if (directory !== undefined) {
          const directories = ancestorDirectories(directory, mount.mountPoint);
          const cpuLimit = minimum(
            directories.map((entry) =>
              readCpuLimitV2(path.posix.join(entry, "cpu.max")),
            ),
          );
          const cpusetLimit =
            readCpusetLimit(
              path.posix.join(directory, "cpuset.cpus.effective"),
            ) ?? readInheritedCpusetLimit(directories);
          const memoryConstraints = directories
            .map((entry) =>
              readMemoryConstraint(
                path.posix.join(entry, "memory.max"),
                path.posix.join(entry, "memory.current"),
              ),
            )
            .filter(
              (constraint): constraint is MemoryConstraint =>
                constraint !== undefined,
            );
          unifiedResources = {
            ...(cpuLimit !== undefined && { cpuLimit }),
            ...(cpusetLimit !== undefined && { cpusetLimit }),
            ...(memoryConstraints.length > 0 && { memoryConstraints }),
          };
        }
      }
    }

    const cpuDirectory = resolveV1Controller("cpu", memberships, mounts);
    const cpusetDirectory = resolveV1Controller("cpuset", memberships, mounts);
    const memoryDirectory = resolveV1Controller("memory", memberships, mounts);
    const cpuLimit =
      cpuDirectory === undefined
        ? undefined
        : minimum(
            ancestorDirectories(
              cpuDirectory.directory,
              cpuDirectory.mountPoint,
            ).map((entry) => readCpuLimitV1(entry)),
          );
    const cpusetLimit =
      cpusetDirectory === undefined
        ? undefined
        : readInheritedCpusetLimit(
            ancestorDirectories(
              cpusetDirectory.directory,
              cpusetDirectory.mountPoint,
            ),
          );
    const memoryConstraints =
      memoryDirectory === undefined
        ? []
        : ancestorDirectories(
            memoryDirectory.directory,
            memoryDirectory.mountPoint,
          )
            .map((entry) =>
              readMemoryConstraint(
                path.posix.join(entry, "memory.limit_in_bytes"),
                path.posix.join(entry, "memory.usage_in_bytes"),
              ),
            )
            .filter(
              (constraint): constraint is MemoryConstraint =>
                constraint !== undefined,
            );
    const effectiveCpuLimit = minimum([unifiedResources.cpuLimit, cpuLimit]);
    const effectiveCpusetLimit = minimum([
      unifiedResources.cpusetLimit,
      cpusetLimit,
    ]);
    const allMemoryConstraints = [
      ...(unifiedResources.memoryConstraints ?? []),
      ...memoryConstraints,
    ];
    return {
      ...(effectiveCpuLimit !== undefined && { cpuLimit: effectiveCpuLimit }),
      ...(effectiveCpusetLimit !== undefined && {
        cpusetLimit: effectiveCpusetLimit,
      }),
      ...(allMemoryConstraints.length > 0 && {
        memoryConstraints: allMemoryConstraints,
      }),
    };
  } catch {
    return {};
  }
}
