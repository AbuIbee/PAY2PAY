import { describe, expect, it } from "vitest";
import { UNUSABLE_PASSWORD_HASH, hashPassword, verifyPassword } from "./password";

const PEPPER = "test-pepper-value";

describe("hashPassword / verifyPassword", () => {
  it("verifies a correct password against its own hash", async () => {
    const stored = await hashPassword("correct horse battery staple", PEPPER);
    await expect(verifyPassword("correct horse battery staple", PEPPER, stored)).resolves.toBe(
      true,
    );
  });

  it("rejects an incorrect password", async () => {
    const stored = await hashPassword("correct horse battery staple", PEPPER);
    await expect(verifyPassword("wrong password", PEPPER, stored)).resolves.toBe(false);
  });

  it("rejects the correct password under a different pepper", async () => {
    const stored = await hashPassword("correct horse battery staple", PEPPER);
    await expect(
      verifyPassword("correct horse battery staple", "a-different-pepper", stored),
    ).resolves.toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    const first = await hashPassword("same password", PEPPER);
    const second = await hashPassword("same password", PEPPER);
    expect(first).not.toBe(second);
  });

  it("always rejects against UNUSABLE_PASSWORD_HASH", async () => {
    await expect(verifyPassword("anything", PEPPER, UNUSABLE_PASSWORD_HASH)).resolves.toBe(false);
  });

  it("rejects a malformed stored hash instead of throwing", async () => {
    await expect(verifyPassword("anything", PEPPER, "not-a-valid-hash")).resolves.toBe(false);
  });
});
