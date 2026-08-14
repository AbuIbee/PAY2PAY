import { describe, expect, it } from "vitest";
import { participantLabel } from "./participantLabels";

describe("participantLabel", () => {
  it("never renders a raw profile/organization id", () => {
    const label = participantLabel(
      { id: "p1", individualProfileId: "11111111-1111-1111-1111-111111111111", organizationId: null, role: "creditor", representedByUserId: "u1" },
      "someone-else",
    );
    expect(label).not.toContain("11111111-1111-1111-1111-111111111111");
  });

  it("labels the caller's own participation as 'You'", () => {
    const label = participantLabel(
      { id: "p1", individualProfileId: "profile-1", organizationId: null, role: "debtor", representedByUserId: "me" },
      "me",
    );
    expect(label).toBe("You (Debtor)");
  });

  it("labels a business counterparty distinctly from an individual counterparty", () => {
    const individual = participantLabel(
      { id: "p1", individualProfileId: "profile-1", organizationId: null, role: "creditor", representedByUserId: "them" },
      "me",
    );
    const business = participantLabel(
      { id: "p2", individualProfileId: null, organizationId: "org-1", role: "creditor", representedByUserId: "them" },
      "me",
    );
    expect(individual).toContain("Individual");
    expect(business).toContain("Business");
  });
});
