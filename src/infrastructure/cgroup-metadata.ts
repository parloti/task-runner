import path from "node:path";

import type {
  CgroupMembership,
  CgroupMount,
  ResolvedCgroupController,
} from "./cgroup-types";

/**
 * List a cgroup directory and its ancestors up to the mount point.
 * @param directory Current cgroup directory.
 * @param mountPoint Root directory of the cgroup mount.
 * @returns Directories from the current group through the mount point.
 * @example `ancestorDirectories("/sys/fs/cgroup/job", "/sys/fs/cgroup")` includes both paths.
 */
export function ancestorDirectories(
  directory: string,
  mountPoint: string,
): string[] {
  const normalizedMount = path.posix.resolve(mountPoint);
  const mountPrefix = normalizedMount.endsWith(path.posix.sep)
    ? normalizedMount
    : `${normalizedMount}${path.posix.sep}`;
  let current = path.posix.resolve(directory);
  if (current !== normalizedMount && !current.startsWith(mountPrefix))
    return [current];
  const directories: string[] = [];
  while (current === normalizedMount || current.startsWith(mountPrefix)) {
    directories.push(current);
    if (current === normalizedMount) break;
    current = path.posix.dirname(current);
  }
  return directories;
}

/**
 * Parse memberships listed in `/proc/self/cgroup`.
 * @param contents Newline-delimited cgroup membership records.
 * @returns Valid memberships with normalized POSIX paths.
 * @example `readCgroupMemberships("0::/worker")` returns the unified membership.
 */
export function readCgroupMemberships(contents: string): CgroupMembership[] {
  return contents.split(/\r?\n/u).flatMap<CgroupMembership>((line) => {
    if (line === "") return [];
    const [hierarchy, controllers, groupPath] = line.split(":", 3);
    if (
      hierarchy === undefined ||
      controllers === undefined ||
      groupPath === undefined
    )
      return [];
    return {
      controllers:
        hierarchy === "0" && controllers === ""
          ? []
          : controllers.split(",").filter(Boolean),
      path: path.posix.normalize(groupPath),
    };
  });
}

/**
 * Parse mount records listed in `/proc/self/mountinfo`.
 * @param contents Newline-delimited mount records.
 * @returns Valid cgroup mounts with decoded POSIX paths.
 * @example `readCgroupMounts("29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw")` reads the cgroup v2 mount.
 */
export function readCgroupMounts(contents: string): CgroupMount[] {
  return contents.split(/\r?\n/u).flatMap<CgroupMount>((line) => {
    const [mountDetails, filesystemDetails] = line.split(" - ", 2);
    if (mountDetails === undefined || filesystemDetails === undefined)
      return [];
    const mountFields = mountDetails.split(" ");
    const filesystemFields = filesystemDetails.split(" ");
    const root = mountFields[3];
    const mountPoint = mountFields[4];
    const type = filesystemFields[0];
    if (root === undefined || mountPoint === undefined || type === undefined)
      return [];
    const options = filesystemFields[2] ?? "";
    return {
      controllers: options.split(","),
      mountPoint: decodeMountPath(mountPoint),
      root: decodeMountPath(root),
      type,
    };
  });
}

/**
 * Map a cgroup path into its mounted POSIX directory.
 * @param mount Cgroup mount metadata.
 * @param membershipPath Path reported for the current process.
 * @returns The mounted directory, or undefined when the membership is outside the mount root.
 * @example `resolveCgroupDirectory(mount, "/tenant/job")` maps the job path under its mount.
 */
export function resolveCgroupDirectory(
  mount: CgroupMount,
  membershipPath: string,
): string | undefined {
  const relative = path.posix.relative(mount.root, membershipPath);
  return relative === ".." || relative.startsWith(`..${path.posix.sep}`)
    ? undefined
    : path.posix.resolve(mount.mountPoint, relative);
}

/**
 * Find the mounted directory for a cgroup v1 controller.
 * @param controller Controller name such as `cpu` or `memory`.
 * @param memberships Parsed process memberships.
 * @param mounts Parsed cgroup mounts.
 * @returns The controller directory and mount point, or undefined when unavailable.
 * @example `resolveV1Controller("cpu", memberships, mounts)` finds the CPU controller mount.
 */
export function resolveV1Controller(
  controller: string,
  memberships: readonly CgroupMembership[],
  mounts: readonly CgroupMount[],
): ResolvedCgroupController | undefined {
  const membership = memberships.find((entry) =>
    entry.controllers.includes(controller),
  );
  const mount = mounts.find(
    (entry) =>
      entry.type === "cgroup" && entry.controllers.includes(controller),
  );
  if (membership === undefined || mount === undefined) return undefined;
  const directory = resolveCgroupDirectory(mount, membership.path);
  return directory === undefined
    ? undefined
    : { directory, mountPoint: mount.mountPoint };
}

/**
 * Decode the octal escapes used for paths in mountinfo.
 * @param value Encoded mount path.
 * @returns The decoded POSIX path.
 * @example `decodeMountPath("/my\\040group")` returns `/my group`.
 */
function decodeMountPath(value: string): string {
  return value.replaceAll(/\\([0-7]{3})/gu, (_match, octal: string) =>
    String.fromCodePoint(Number.parseInt(octal, 8)),
  );
}
