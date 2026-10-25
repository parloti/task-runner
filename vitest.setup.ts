import { afterEach, beforeEach, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});
