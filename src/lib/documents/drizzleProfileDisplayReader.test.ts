import { describe, expect, it } from "vitest";
import { resolvePersonalProfileDisplayName } from "./drizzleProfileDisplayReader";

/**
 * Production defect remediation (canonical connection + party name display) — Legacy Party Name Rule,
 * tests 21-24: proves the exact fallback chain that replaced the old bug where any personal profile
 * with no `legal_name` rendered the internal placeholder string "Personal profile" as if it were a
 * person's identity. Order: (1) first_name + last_name, (2) legacy legal_name, (3) "Name not provided"
 * — and confirms "Personal profile" can never be produced by this function, and no name is ever
 * fabricated from an email address (this function never receives one).
 */
describe("resolvePersonalProfileDisplayName", () => {
  it("prefers first_name + last_name when both are present", () => {
    expect(resolvePersonalProfileDisplayName({ firstName: "Jordan", lastName: "Lee", legalName: "Jordan A. Lee LLC" })).toBe("Jordan Lee");
  });

  it("trims whitespace around first/last name", () => {
    expect(resolvePersonalProfileDisplayName({ firstName: "  Jordan  ", lastName: "  Lee  ", legalName: null })).toBe("Jordan Lee");
  });

  it("falls back to legal_name when first_name or last_name is missing", () => {
    expect(resolvePersonalProfileDisplayName({ firstName: null, lastName: null, legalName: "Jordan Lee" })).toBe("Jordan Lee");
    expect(resolvePersonalProfileDisplayName({ firstName: "Jordan", lastName: null, legalName: "Jordan Lee" })).toBe("Jordan Lee");
    expect(resolvePersonalProfileDisplayName({ firstName: null, lastName: "Lee", legalName: "Jordan Lee" })).toBe("Jordan Lee");
  });

  it("falls back to legal_name when first_name/last_name are empty/whitespace-only strings", () => {
    expect(resolvePersonalProfileDisplayName({ firstName: "  ", lastName: "  ", legalName: "Jordan Lee" })).toBe("Jordan Lee");
  });

  it("trims legal_name", () => {
    expect(resolvePersonalProfileDisplayName({ firstName: null, lastName: null, legalName: "  Jordan Lee  " })).toBe("Jordan Lee");
  });

  it("falls back to 'Name not provided' when no name data exists at all — never 'Personal profile', never fabricated from email", () => {
    expect(resolvePersonalProfileDisplayName({ firstName: null, lastName: null, legalName: null })).toBe("Name not provided");
    expect(resolvePersonalProfileDisplayName(undefined)).toBe("Name not provided");
  });

  it("falls back to 'Name not provided' when legal_name is empty/whitespace-only", () => {
    expect(resolvePersonalProfileDisplayName({ firstName: null, lastName: null, legalName: "   " })).toBe("Name not provided");
  });

  it("never returns the literal internal placeholder 'Personal profile' for any input shape", () => {
    const cases = [
      { firstName: null, lastName: null, legalName: null },
      { firstName: "", lastName: "", legalName: "" },
      { firstName: "Jordan", lastName: null, legalName: null },
      undefined,
    ];
    for (const row of cases) {
      expect(resolvePersonalProfileDisplayName(row)).not.toBe("Personal profile");
    }
  });
});
