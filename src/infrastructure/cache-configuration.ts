import type { CacheDefinition } from "../domain";

/**
 * Validate caller-declared, config-relative cache patterns at the IO boundary.
 * @param value Unknown cache definition from configuration JSON.
 * @returns Validated input, output, exclusion, and environment declarations.
 * @example `parseCacheDefinition({ inputs: ["src/**"] })` validates source inputs.
 */
export function parseCacheDefinition(value: unknown): CacheDefinition {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected object: task cache");
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find(
    (key) => !["env", "exclude", "inputs", "outputs"].includes(key),
  );
  if (unknown !== undefined)
    throw new Error(`Unknown property "${unknown}" in task cache`);
  const inputs = patterns(input["inputs"], "inputs");
  if (inputs.length === 0) throw new Error("Cache inputs must not be empty");
  return {
    inputs,
    ...(input["exclude"] !== undefined && {
      exclude: patterns(input["exclude"], "exclude"),
    }),
    ...(input["outputs"] !== undefined && {
      outputs: patterns(input["outputs"], "outputs"),
    }),
    ...(input["env"] !== undefined && { env: strings(input["env"], "env") }),
  };
}

/**
 * Require file patterns confined to the configuration root.
 * @param value Unknown pattern list.
 * @param label Cache field used in validation errors.
 * @returns Checked root-relative patterns.
 * @example `patterns(["src/**"], "inputs")` accepts a source pattern.
 */
function patterns(value: unknown, label: string): string[] {
  return strings(value, label).map((pattern) => {
    const pathPattern = pattern.replaceAll(/\\([()*?{}[\]!])/gu, "$1");
    if (
      pattern.startsWith("/") ||
      pattern.startsWith("!") ||
      /[\\:]/u.test(pathPattern) ||
      pattern.split("/").some((part) => part === ".." || part === ".")
    )
      throw new Error(
        `Cache ${label} pattern must be root-relative: ${pattern}`,
      );
    return pattern;
  });
}

/**
 * Require an array of non-empty cache declarations.
 * @param value Unknown array value.
 * @param label Cache field used in validation errors.
 * @returns Checked non-empty strings.
 * @example `strings(["NODE_ENV"], "env")` validates environment names.
 */
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value))
    throw new TypeError(`Expected string array: cache ${label}`);
  return value.map((item: unknown) => {
    if (typeof item !== "string" || item.trim() === "")
      throw new TypeError(`Expected non-empty string: cache ${label}`);
    return item;
  });
}
