import { describe, expect, it } from "vitest";
import { generatePublicReferenceCode } from "./token";

/** Section K (closed-beta remediation, Product Owner review). */
describe("generatePublicReferenceCode", () => {
  it("matches the P2P-XXXXXXXX format, using only unambiguous characters", () => {
    const code = generatePublicReferenceCode();
    expect(code).toMatch(/^P2P-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
  });

  it("excludes visually ambiguous characters (0, O, 1, I)", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generatePublicReferenceCode();
      expect(code).not.toMatch(/[0O1I]/);
    }
  });

  it("is not sequential — generates distinct codes across repeated calls", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generatePublicReferenceCode()));
    expect(codes.size).toBe(50);
  });
});
