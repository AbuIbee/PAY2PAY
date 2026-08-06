import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, resetRateLimits } from "./rate-limit";

describe("checkRateLimit", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("allows requests up to the limit within the window", () => {
    const now = 1_000_000;
    expect(checkRateLimit("k", 3, 60_000, now)).toBe(true);
    expect(checkRateLimit("k", 3, 60_000, now)).toBe(true);
    expect(checkRateLimit("k", 3, 60_000, now)).toBe(true);
  });

  it("blocks the request that exceeds the limit within the window", () => {
    const now = 1_000_000;
    checkRateLimit("k", 2, 60_000, now);
    checkRateLimit("k", 2, 60_000, now);
    expect(checkRateLimit("k", 2, 60_000, now)).toBe(false);
  });

  it("resets the count once the window has elapsed", () => {
    const start = 1_000_000;
    checkRateLimit("k", 1, 60_000, start);
    expect(checkRateLimit("k", 1, 60_000, start)).toBe(false);
    expect(checkRateLimit("k", 1, 60_000, start + 60_001)).toBe(true);
  });

  it("tracks separate keys independently", () => {
    const now = 1_000_000;
    checkRateLimit("a", 1, 60_000, now);
    expect(checkRateLimit("a", 1, 60_000, now)).toBe(false);
    expect(checkRateLimit("b", 1, 60_000, now)).toBe(true);
  });
});
