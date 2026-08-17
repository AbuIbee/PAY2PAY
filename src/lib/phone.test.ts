import { describe, expect, it } from "vitest";
import { isValidE164, maskPhone, normalizeE164 } from "./phone";

describe("normalizeE164", () => {
  it("passes through an already-valid E.164 value", () => {
    expect(normalizeE164("+15551234567")).toBe("+15551234567");
  });

  it("strips formatting punctuation from a +-prefixed value", () => {
    expect(normalizeE164("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("assumes +1 for a bare 10-digit US number", () => {
    expect(normalizeE164("5551234567")).toBe("+15551234567");
  });

  it("normalizes common US formatting", () => {
    expect(normalizeE164("(555) 123-4567")).toBe("+15551234567");
    expect(normalizeE164("555-123-4567")).toBe("+15551234567");
  });

  it("accepts an 11-digit number already prefixed with a US country code (no +)", () => {
    expect(normalizeE164("15551234567")).toBe("+15551234567");
  });

  it("rejects an empty or whitespace-only value", () => {
    expect(normalizeE164("")).toBeNull();
    expect(normalizeE164("   ")).toBeNull();
  });

  it("rejects a too-short number", () => {
    expect(normalizeE164("12345")).toBeNull();
  });

  it("rejects a non-US number with no country code (ambiguous length)", () => {
    expect(normalizeE164("12345678901234")).toBeNull();
  });

  it("rejects garbage input rather than guessing", () => {
    expect(normalizeE164("not-a-phone-number")).toBeNull();
    expect(normalizeE164("+")).toBeNull();
  });

  it("rejects an E.164-shaped value starting with 0 after the +", () => {
    expect(normalizeE164("+05551234567")).toBeNull();
  });
});

describe("isValidE164", () => {
  it("accepts a well-formed E.164 value", () => {
    expect(isValidE164("+15551234567")).toBe(true);
  });

  it("rejects a value without a leading +", () => {
    expect(isValidE164("15551234567")).toBe(false);
  });

  it("rejects a value with formatting punctuation", () => {
    expect(isValidE164("+1 (555) 123-4567")).toBe(false);
  });
});

describe("maskPhone", () => {
  it("keeps only the country-code prefix and the last two digits", () => {
    expect(maskPhone("+15551234567")).toBe("+1********67");
  });

  it("never reveals the full number", () => {
    const masked = maskPhone("+15551234567");
    expect(masked).not.toBe("+15551234567");
    expect(masked).not.toContain("5551234");
  });
});
