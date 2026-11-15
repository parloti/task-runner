import { globby } from "globby";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export interface FileSnapshot {
  readonly complete: boolean;
  readonly digest: string;
  readonly empty: boolean;
}

/**
 * Hash sorted file identities and contents, including additions and deletions.
 * @param root Absolute configuration root.
 * @param patterns Root-relative file patterns to hash.
 * @param exclude Patterns excluded from discovery.
 * @returns Content digest, absence state, and whether every pattern matched.
 * @example `snapshotFiles(root, ["src/**"])` fingerprints a source tree.
 */
export async function snapshotFiles(
  root: string,
  patterns: readonly string[],
  exclude: readonly string[] = [],
): Promise<FileSnapshot> {
  const files = new Set<string>();
  const resolvedRoot = await realpath(root);
  let complete = true;
  for (const pattern of patterns) {
    let matched = false;
    const matches = await globby(pattern, {
      cwd: root,
      dot: true,
      expandDirectories: false,
      followSymbolicLinks: false,
      ignore: [".cache/task-runner", ".cache/task-runner/**", ...exclude],
      onlyFiles: false,
    });
    for (const name of matches) {
      const absolute = path.resolve(root, name);
      const relative = path.relative(root, absolute);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error(
          `Cache file is outside the configuration root: ${absolute}`,
        );
      const stat = await lstat(absolute);
      if (
        stat.isSymbolicLink() ||
        (await realpath(absolute)) !== path.join(resolvedRoot, relative)
      )
        throw new Error(
          `Symbolic-link cache input is unsupported: ${absolute}`,
        );
      if (!stat.isFile()) {
        continue;
      }

      matched = true;
      files.add(name);
    }
    complete &&= matched;
  }
  const hash = createHash("sha256");
  const names = files
    .values()
    .toArray()
    .toSorted((left, right) => left.localeCompare(right));
  for (const name of names) {
    const digest = createHash("sha256")
      .update(await readFile(path.resolve(root, name)))
      .digest("hex");
    hash.update(JSON.stringify([name.replaceAll("\\", "/"), digest]));
  }
  return { complete, digest: hash.digest("hex"), empty: files.size === 0 };
}
