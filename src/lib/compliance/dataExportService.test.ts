import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestDataExportService } from "./testFakes";

describe("DataExportService", () => {
  it("exports the caller's own profiles, agreements, and consent history — never another user's", async () => {
    const { dataExportService, personalProfiles, agreementCtx, consentService, accounts } = createTestDataExportService();

    const userId = randomUUID();
    accounts.emails.set(userId, "user@example.com");
    const personalProfile = await personalProfiles.insert(userId);
    agreementCtx.profileOwners.set("personal", personalProfile.id, userId);

    const otherUserId = randomUUID();
    const otherProfileId = randomUUID();
    agreementCtx.profileOwners.set("personal", otherProfileId, otherUserId);

    // An agreement belonging to this user...
    await agreementCtx.agreements.insert({
      creditorProfileKind: "personal",
      creditorProfileId: personalProfile.id,
      debtorProfileKind: "personal",
      debtorProfileId: "counterparty-1",
      currency: "USD",
      createdByUserId: userId,
    });
    // ...and one belonging to someone else entirely, which must never appear in this export.
    await agreementCtx.agreements.insert({
      creditorProfileKind: "personal",
      creditorProfileId: otherProfileId,
      debtorProfileKind: "personal",
      debtorProfileId: "counterparty-2",
      currency: "USD",
      createdByUserId: otherUserId,
    });

    await consentService.recordConsent({ userId, policyType: "terms_of_service", policyVersion: "v1", method: "signup_checkbox", ipAddress: null });

    const result = await dataExportService.exportForUser(userId);

    expect(result.userId).toBe(userId);
    expect(result.email).toBe("user@example.com");
    expect(result.profiles).toEqual([{ kind: "personal", id: personalProfile.id, displayName: "Personal" }]);
    expect(result.agreements).toHaveLength(1);
    expect(result.agreements[0]?.creditorProfileId).toBe(personalProfile.id);
    expect(result.consents).toHaveLength(1);
    expect(result.consents[0]?.policyType).toBe("terms_of_service");
    expect(result.exportedAt).toBeTruthy();
  });

  it("returns an empty (not erroring) export for a brand-new user with no agreements or consents yet", async () => {
    const { dataExportService, personalProfiles, agreementCtx } = createTestDataExportService();
    const userId = randomUUID();
    const personalProfile = await personalProfiles.insert(userId);
    agreementCtx.profileOwners.set("personal", personalProfile.id, userId);

    const result = await dataExportService.exportForUser(userId);
    expect(result.agreements).toEqual([]);
    expect(result.consents).toEqual([]);
  });
});
