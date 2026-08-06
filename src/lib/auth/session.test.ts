import { describe, expect, it } from "vitest";
import { generateSessionToken, hashSessionToken } from "./session";

describe("generateSessionToken", () => {
  it("generates a non-empty, URL-safe token that differs each call", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("hashSessionToken", () => {
  it("is deterministic for the same token", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it("produces a 64-char hex sha256 digest", () => {
    expect(hashSessionToken("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different tokens", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(hashSessionToken(a)).not.toBe(hashSessionToken(b));
  });

  it("never reproduces the raw token in the hash", () => {
    const token = "a-known-raw-token-value";
    expect(hashSessionToken(token)).not.toContain(token);
  });
});
