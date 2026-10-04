import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { CURRENT_LEGAL_DOCUMENT_VERSIONS, REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES } from "./legalDocumentVersions";
import { createTestLegalAcceptanceService } from "./legalAcceptanceTestFakes";

describe("LegalAcceptanceService (PAID2YOU PRODUCTION LAUNCH, Phase 2, Section 3/4/8/9/24)", () => {
  it("records an acceptance with the server-resolved current version, never a client-supplied one — there is no parameter for one", async () => {
    const { legalAcceptanceService, repo } = createTestLegalAcceptanceService();
    const record = await legalAcceptanceService.recordAcceptance({ userId: "user-1", organizationId: "org-1", documentType: "terms" });
    expect(record.documentVersion).toBe(CURRENT_LEGAL_DOCUMENT_VERSIONS.terms);
    expect(repo.rows).toHaveLength(1);
  });

  it("rejects an unrecognized document type", async () => {
    const { legalAcceptanceService } = createTestLegalAcceptanceService();
    await expect(legalAcceptanceService.recordAcceptance({ userId: "user-1", organizationId: "org-1", documentType: "made_up_document" })).rejects.toThrow(ValidationError);
  });

  it("is idempotent: the same user re-accepting the same current version creates no duplicate row", async () => {
    const { legalAcceptanceService, repo } = createTestLegalAcceptanceService();
    await legalAcceptanceService.recordAcceptance({ userId: "user-1", organizationId: "org-1", documentType: "terms" });
    await legalAcceptanceService.recordAcceptance({ userId: "user-1", organizationId: "org-1", documentType: "terms" });
    expect(repo.rows).toHaveLength(1);
  });

  it("getOrganizationAcceptanceStatus reports accepted:true only for a document type whose CURRENT version has been recorded for that organization", async () => {
    const { legalAcceptanceService } = createTestLegalAcceptanceService();
    await legalAcceptanceService.recordAcceptance({ userId: "owner-1", organizationId: "org-1", documentType: "terms" });

    const status = await legalAcceptanceService.getOrganizationAcceptanceStatus("org-1", REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES);
    const terms = status.find((s) => s.documentType === "terms")!;
    const policy = status.find((s) => s.documentType === "business_subscription_policy")!;
    expect(terms.accepted).toBe(true);
    expect(terms.acceptedVersion).toBe(CURRENT_LEGAL_DOCUMENT_VERSIONS.terms);
    expect(policy.accepted).toBe(false);
    expect(policy.acceptedVersion).toBeNull();
  });

  it("an acceptance of an OLD version is never reported as current — re-acceptance is required once the version moves forward (Section 9)", async () => {
    const { legalAcceptanceService, repo } = createTestLegalAcceptanceService();
    // Simulate a historical acceptance of a version that is no longer current.
    await repo.insert({ userId: "owner-1", organizationId: "org-1", documentType: "terms", documentVersion: "2020-01-01", acceptedAt: new Date(), metadata: null });

    const hasAll = await legalAcceptanceService.hasAllCurrentAcceptances("org-1", ["terms"]);
    expect(hasAll).toBe(false);

    const status = await legalAcceptanceService.getOrganizationAcceptanceStatus("org-1", ["terms"]);
    expect(status[0]?.accepted).toBe(false);
  });

  it("does not force re-acceptance merely because a timestamp passed — re-accepting the same current version twice in a row is a harmless no-op, not an error", async () => {
    const { legalAcceptanceService } = createTestLegalAcceptanceService();
    const first = await legalAcceptanceService.recordAcceptance({ userId: "owner-1", organizationId: "org-1", documentType: "recurring_payment_authorization" });
    const second = await legalAcceptanceService.recordAcceptance({ userId: "owner-1", organizationId: "org-1", documentType: "recurring_payment_authorization" });
    expect(second.id).toBe(first.id);
  });

  it("hasAllCurrentAcceptances requires every listed document type to be individually current", async () => {
    const { legalAcceptanceService } = createTestLegalAcceptanceService();
    await legalAcceptanceService.recordAcceptance({ userId: "owner-1", organizationId: "org-1", documentType: "terms" });
    await legalAcceptanceService.recordAcceptance({ userId: "owner-1", organizationId: "org-1", documentType: "business_subscription_policy" });
    // recurring_payment_authorization intentionally never accepted.
    expect(await legalAcceptanceService.hasAllCurrentAcceptances("org-1", REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES)).toBe(false);

    await legalAcceptanceService.recordAcceptance({ userId: "owner-1", organizationId: "org-1", documentType: "recurring_payment_authorization" });
    expect(await legalAcceptanceService.hasAllCurrentAcceptances("org-1", REQUIRED_BUSINESS_ACTIVATION_DOCUMENT_TYPES)).toBe(true);
  });

  it("cross-organization acceptance cannot satisfy another organization's requirement (Section 24)", async () => {
    const { legalAcceptanceService } = createTestLegalAcceptanceService();
    await legalAcceptanceService.recordAcceptance({ userId: "owner-of-org-a", organizationId: "org-a", documentType: "terms" });

    expect(await legalAcceptanceService.hasAllCurrentAcceptances("org-b", ["terms"])).toBe(false);
    const statusForB = await legalAcceptanceService.getOrganizationAcceptanceStatus("org-b", ["terms"]);
    expect(statusForB[0]?.accepted).toBe(false);
  });

  it("a Personal-scope acceptance (organizationId null) is recorded and read back independently of any organization", async () => {
    const { legalAcceptanceService, repo } = createTestLegalAcceptanceService();
    await legalAcceptanceService.recordAcceptance({ userId: "personal-user", organizationId: null, documentType: "terms" });
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]?.organizationId).toBeNull();
  });
});
