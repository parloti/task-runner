import { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { ProcessDiagnostics } from "./process-diagnostics";

describe("process diagnostic observations", () => {
  it.each(["exit", "signal"])(
    "preserves %s evidence and separates exit from stream closure",
    (mode) => {
      // Arrange
      vi.useFakeTimers();
      const child = new ChildProcess();
      Object.defineProperty(child, "pid", { value: 12_345 });
      const diagnostics = new ProcessDiagnostics("logs/task.log");
      diagnostics.observe(child);
      const code = mode === "exit" ? 7 : child.exitCode;
      const signal = mode === "signal" ? "SIGTERM" : child.signalCode;

      // Act
      child.emit("exit", code, signal);
      diagnostics.requestTermination("cleanup");
      vi.advanceTimersByTime(20);
      child.emit("close", code, signal);
      const evidence = diagnostics.finish();

      // Assert
      expect(evidence).toHaveProperty(
        mode === "exit" ? "exitCode" : "signal",
        mode === "exit" ? 7 : "SIGTERM",
      );
      expect(evidence.pid).toBe(12_345);
      expect(evidence.logPath).toBe("logs/task.log");
      expect(evidence.closedAt).not.toBe(evidence.exitedAt);
      expect(evidence.host.sampleCount).toBe(2);
      expect(evidence).not.toHaveProperty("terminationRequested");
      expect(evidence).not.toHaveProperty("cause");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("records the first runner termination request without confusing it with the original error", () => {
    // Arrange
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 12_345 });
    const diagnostics = new ProcessDiagnostics();
    diagnostics.observe(child);

    // Act
    diagnostics.requestTermination("cancellation");
    diagnostics.requestTermination("cleanup");
    diagnostics.recordError(
      Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
    );
    const evidence = diagnostics.finish();

    // Assert
    expect(evidence).toHaveProperty(
      "terminationRequested.reason",
      "cancellation",
    );
    expect(evidence.errorCode).toBe("ENOENT");
    expect(evidence).not.toHaveProperty("logPath");
  });

  it("records synchronous setup failures without inventing a PID or termination request", () => {
    // Arrange
    const diagnostics = new ProcessDiagnostics();

    // Act
    diagnostics.requestTermination("cleanup");
    diagnostics.recordError(new Error("setup failed"));
    const evidence = diagnostics.finish();

    // Assert
    expect(evidence).not.toHaveProperty("pid");
    expect(evidence).not.toHaveProperty("errorCode");
    expect(evidence).not.toHaveProperty("terminationRequested");
    expect(evidence.host.sampleCount).toBe(2);
  });
});
