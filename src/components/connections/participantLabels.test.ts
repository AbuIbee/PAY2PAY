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

  it("current_agreement_id / relationship_participant.role audit (item 3): prefers effectiveRole over the permanent, potentially-stale relationship_participant.role", () => {
    // Stored role says "creditor" (the connection's ORIGINAL role), but the current governing
    // agreement's real role — effectiveRole — says "debtor" (a later, role-reversed reuse of the same
    // canonical connection). The label must reflect the CURRENT agreement, never the stale storage.
    const label = participantLabel(
      { id: "p1", individualProfileId: "profile-1", organizationId: null, role: "creditor", effectiveRole: "debtor", representedByUserId: "me" },
      "me",
    );
    expect(label).toBe("You (Debtor)");
  });

  it("falls back to the stored role when effectiveRole is absent (no governing agreement yet, or an older caller)", () => {
    const label = participantLabel(
      { id: "p1", individualProfileId: "profile-1", organizationId: null, role: "creditor", representedByUserId: "me" },
      "me",
    );
    expect(label).toBe("You (Creditor)");
  });
});
