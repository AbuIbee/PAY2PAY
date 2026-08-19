import { describe, expect, it } from "vitest";
import { accountNumbersMatch, isValidAccountNumber, isValidRoutingNumber } from "./bankAccountValidation";

describe("isValidRoutingNumber", () => {
  it("accepts a routing number whose ABA checksum is a multiple of 10", () => {
    // 021000021 is Chase's real, publicly documented routing number — a well-known valid checksum
    // example, not a secret.
    expect(isValidRoutingNumber("021000021")).toBe(true);
  });

  it("rejects a routing number with an invalid checksum", () => {
    expect(isValidRoutingNumber("123456789")).toBe(false);
  });

  it("rejects a routing number that is not exactly 9 digits", () => {
    expect(isValidRoutingNumber("12345")).toBe(false);
    expect(isValidRoutingNumber("0210000210")).toBe(false);
  });

  it("rejects non-numeric input", () => {
    expect(isValidRoutingNumber("02100002a")).toBe(false);
  });
});

describe("isValidAccountNumber", () => {
  it("accepts a numeric string between 4 and 17 digits", () => {
    expect(isValidAccountNumber("1234")).toBe(true);
    expect(isValidAccountNumber("12345678901234567")).toBe(true);
  });

  it("rejects too-short, too-long, or non-numeric input", () => {
    expect(isValidAccountNumber("123")).toBe(false);
    expect(isValidAccountNumber("123456789012345678")).toBe(false);
    expect(isValidAccountNumber("12a4")).toBe(false);
  });
});

describe("accountNumbersMatch", () => {
  it("requires a non-empty, exact match", () => {
    expect(accountNumbersMatch("12345", "12345")).toBe(true);
    expect(accountNumbersMatch("12345", "12346")).toBe(false);
    expect(accountNumbersMatch("", "")).toBe(false);
  });
});
