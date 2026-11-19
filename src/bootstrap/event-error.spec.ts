import { describe, expect, it } from "vitest";

import { serializeEventError } from "./event-error";

describe("structured event errors", () => {
  it("preserves error codes and original failures through aggregates and causes", () => {
    // Arrange
    const original = Object.assign(new Error("command failed"), { code: 7 });
    const cleanup = Object.assign(new Error("cleanup denied"), {
      code: "EPERM",
    });
    const error = new AggregateError(
      [original, cleanup],
      "execution and cleanup failed",
      { cause: cleanup },
    );

    // Act
    const evidence = serializeEventError(error);

    // Assert
    expect(evidence).toEqual({
      cause: { code: "EPERM", message: "cleanup denied", name: "Error" },
      errors: [
        { code: 7, message: "command failed", name: "Error" },
        { code: "EPERM", message: "cleanup denied", name: "Error" },
      ],
      message: "execution and cleanup failed",
      name: "AggregateError",
    });
  });

  it("bounds circular causes, aggregate width, and message length without copying arbitrary properties", () => {
    // Arrange
    const cause = new Error("nested", { cause: undefined });
    Object.defineProperty(cause, "cause", { value: cause });
    const error = new AggregateError(
      Array.from({ length: 11 }, () => cause),
      "x".repeat(5000),
    );
    Object.assign(error, { environment: "must not be copied" });

    // Act
    const evidence = serializeEventError(error);

    // Assert
    expect(evidence.message).toHaveLength(4096);
    expect(evidence.errors).toHaveLength(10);
    expect(evidence.truncated).toBe(true);
    expect(JSON.stringify(evidence)).toContain('"truncated":true');
    expect(evidence).not.toHaveProperty("environment");
    expect(serializeEventError("rejected")).toEqual({
      message: "rejected",
      name: "NonError",
    });
  });
});
