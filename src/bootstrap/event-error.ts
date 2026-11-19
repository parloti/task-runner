interface EventError {
  readonly cause?: EventError;
  readonly code?: number | string;
  readonly errors?: readonly EventError[];
  readonly message: string;
  readonly name: string;
  readonly truncated?: boolean;
}

/**
 * Preserve bounded error evidence without serializing arbitrary error properties.
 * @param error Error or rejection value emitted at an execution boundary.
 * @returns JSON-safe names, messages, codes, and causal relationships.
 * @example `serializeEventError(error)` preserves an aggregate's original failures.
 */
export function serializeEventError(error: unknown): EventError {
  let remaining = 32;
  const serialize = (value: unknown, depth: number): EventError => {
    if (remaining-- <= 0)
      return {
        message: "Error detail limit reached",
        name: "TruncatedError",
        truncated: true,
      };
    return serializeError(value, depth, serialize);
  };
  return serialize(error, 0);
}

/**
 * Serialize one bounded level of an execution error.
 * @param error Error or rejection value.
 * @param depth Current nesting depth.
 * @param serialize Visitor sharing the remaining error budget.
 * @returns JSON-safe error evidence.
 * @example `serializeError(error, 0, visit)` captures the top-level error.
 */
function serializeError(
  error: unknown,
  depth: number,
  serialize: (value: unknown, depth: number) => EventError,
): EventError {
  if (!(error instanceof Error))
    return { message: String(error).slice(0, 4096), name: "NonError" };
  const result = {
    message: error.message.slice(0, 4096),
    name: error.name.slice(0, 256),
    ...("code" in error &&
      (typeof error.code === "string" || typeof error.code === "number") && {
        code:
          typeof error.code === "string"
            ? error.code.slice(0, 256)
            : error.code,
      }),
  };
  if (depth >= 4) return { ...result, truncated: true };
  return {
    ...result,
    ...(error.cause !== undefined && {
      cause: serialize(error.cause, depth + 1),
    }),
    ...(error instanceof AggregateError && {
      errors: error.errors
        .slice(0, 10)
        .map((nested: unknown) => serialize(nested, depth + 1)),
      ...(error.errors.length > 10 && { truncated: true }),
    }),
  };
}
