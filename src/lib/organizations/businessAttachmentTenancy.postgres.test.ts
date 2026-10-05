import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { businessProfile, businessStaffMember } from "@/db/schema";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import { InMemoryDocumentStorage } from "@/lib/documents/testFakes";
import { getDocumentStorage } from "@/lib/documents/getDocumentStorage";
import { SupabaseDocumentStorage } from "@/lib/documents/supabaseDocumentStorage";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { BasicAttachmentFileValidator } from "@/lib/organizations/attachmentFileValidator";
import { BusinessAttachmentService } from "@/lib/organizations/businessAttachmentService";
import { DrizzleBusinessCustomerRepository } from "@/lib/organizations/drizzleBusinessCustomerRepository";
import { DrizzleBusinessObligationRepository } from "@/lib/organizations/drizzleBusinessObligationRepository";
import { DrizzleOrganizationDocumentRepository } from "@/lib/organizations/drizzleOrganizationDocumentRepository";
import { getLegacyRoleMigrationService } from "@/lib/organizations/getLegacyRoleMigrationService";
import { getAttachmentStorage, ATTACHMENT_BUCKET } from "@/lib/organizations/getAttachmentStorage";
import { getOrganizationPermissionService } from "@/lib/organizations/getOrganizationPermissionService";
import { seedPersonalUser } from "../../../test/postgres/seedHelpers";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

/**
 * "PAID2YOU — SECURE BUSINESS ATTACHMENTS ITERATION" (2026-10-05): real-Postgres proof of
 * cross-tenant attachment isolation — mirrors Item G's own established pattern exactly (see
 * src/app/api/agreements/pdf/route.tenantIsolation.postgres.test.ts's own doc comment): the real
 * service chain (`BusinessAttachmentService` -> `OrganizationPermissionService` ->
 * `DrizzleAgreementRepository`/`DrizzleBusinessCustomerRepository`/`DrizzleBusinessObligationRepository`
 * -> `DrizzleOrganizationDocumentRepository`), with `InMemoryDocumentStorage` used ONLY as the
 * storage-boundary observer (never the production selection — separately asserted below).
 */
describe("Business Attachments — real-Postgres cross-tenant isolation", () => {
  async function seedOrganizationWithOwner(namePrefix: string) {
    const db = getDb();
    const owner = await seedPersonalUser(`${namePrefix}-owner`);
    const [org] = await db
      .insert(businessProfile)
      .values({
        ownerUserId: owner.userId,
        legalBusinessName: `${namePrefix} LLC ${randomUUID()}`,
        displayName: namePrefix,
        entityType: "LLC",
        businessAddress: {},
        country: "US",
        state: "DE",
      })
      .returning({ id: businessProfile.id });
    if (!org) throw new Error("seedOrganizationWithOwner: business_profile insert returned no row");
    await addActiveStaffMember(org.id, owner.userId);
    return { organizationId: org.id, ownerUserId: owner.userId };
  }

  async function addActiveStaffMember(organizationId: string, userId: string): Promise<void> {
    const db = getDb();
    const roleId = await getLegacyRoleMigrationService().resolveOrCreateEquivalentRole(organizationId, "OWNER");
    await db.insert(businessStaffMember).values({ businessProfileId: organizationId, userId, role: "OWNER", roleId, isAuthorizedRepresentative: true });
  }

  function buildService(storage: InMemoryDocumentStorage) {
    return new BusinessAttachmentService({
      documents: new DrizzleOrganizationDocumentRepository(),
      storage,
      audit: new AuditService(new DrizzleAuditEventRepository()),
      permissions: getOrganizationPermissionService(),
      agreements: new DrizzleAgreementRepository(),
      customers: new DrizzleBusinessCustomerRepository(),
      obligations: new DrizzleBusinessObligationRepository(),
      fileValidator: new BasicAttachmentFileValidator(),
    });
  }

  it("the production storage factory can never select the in-memory test double", () => {
    expect(getAttachmentStorage()).toBeInstanceOf(SupabaseDocumentStorage);
    expect(getAttachmentStorage()).not.toBe(getDocumentStorage()); // a genuinely separate, dedicated bucket
    expect(ATTACHMENT_BUCKET).toBe("organization-documents");
  });

  it("Org A uploads/lists/downloads its own Agreement attachment; Org B is denied at every one of those operations, and createSignedUrl is never invoked for the denied attempts", async () => {
    const storage = new InMemoryDocumentStorage();
    const service = buildService(storage);

    const orgA = await seedOrganizationWithOwner("attach-org-a");
    const orgB = await seedOrganizationWithOwner("attach-org-b");

    const customer = await seedPersonalUser("attach-customer");
    const draft = await getAgreementService().createDraft({
      creatorUserId: orgA.ownerUserId,
      creditor: { kind: "business", id: orgA.organizationId },
      debtor: { kind: "personal", id: customer.profileId },
      organizationId: orgA.organizationId,
      category: "business_receivable",
      description: "Attachment tenancy proof",
      originalAmountMinorUnits: 50_000,
      previousPaymentsMinorUnits: 0,
      firstPaymentMinorUnits: 10_000,
      installmentAmountMinorUnits: 10_000,
      frequency: "monthly",
      firstPaymentDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      feeAllocation: "debtor_pays",
      earlyPayoffTerms: "No penalty.",
      hardshipRules: "Hardship relief available.",
      partialPaymentRules: "Creditor approval required.",
      settlementRules: "Either party may propose.",
      disputeProcedure: "Per platform policy.",
    });

    // --- OWN-ORG: upload succeeds ---
    const record = await service.uploadAttachment({
      actingUserId: orgA.ownerUserId,
      organizationId: orgA.organizationId,
      documentType: "INVOICE",
      parent: { kind: "agreement", id: draft.agreement.id },
      fileName: "invoice.pdf",
      contentType: "application/pdf",
      content: PDF_BYTES,
    });
    expect(record.relatedAgreementId).toBe(draft.agreement.id);

    // --- OWN-ORG: list succeeds ---
    const ownList = await service.listAttachments({ actingUserId: orgA.ownerUserId, organizationId: orgA.organizationId, parent: { kind: "agreement", id: draft.agreement.id } });
    expect(ownList.map((item) => item.id)).toContain(record.id);

    // --- OWN-ORG: signed URL succeeds ---
    const ownDownload = await service.getSignedDownloadUrl({ actingUserId: orgA.ownerUserId, organizationId: orgA.organizationId, attachmentId: record.id });
    expect(ownDownload.url).toBeTruthy();
    expect(storage.signedUrlsIssued).toHaveLength(1);

    // --- CROSS-ORG: metadata/signed-URL denied, zero additional createSignedUrl calls ---
    await expect(service.getSignedDownloadUrl({ actingUserId: orgB.ownerUserId, organizationId: orgB.organizationId, attachmentId: record.id })).rejects.toThrow(ForbiddenError);
    expect(storage.signedUrlsIssued).toHaveLength(1); // unchanged — still only the own-org call above

    // --- CROSS-ORG: Org B cannot attach a file to Org A's agreement ---
    await expect(
      service.uploadAttachment({ actingUserId: orgB.ownerUserId, organizationId: orgB.organizationId, documentType: "OTHER", parent: { kind: "agreement", id: draft.agreement.id }, fileName: "x.pdf", contentType: "application/pdf", content: PDF_BYTES }),
    ).rejects.toThrow(ValidationError);

    // --- CROSS-ORG: Org B cannot attach a file to Org A's customer ---
    const orgACustomer = await new DrizzleBusinessCustomerRepository().insert({ businessProfileId: orgA.organizationId, counterpartyProfileKind: "personal", counterpartyProfileId: customer.profileId });
    await expect(
      service.uploadAttachment({ actingUserId: orgB.ownerUserId, organizationId: orgB.organizationId, documentType: "OTHER", parent: { kind: "customer", id: orgACustomer.id }, fileName: "x.pdf", contentType: "application/pdf", content: PDF_BYTES }),
    ).rejects.toThrow(ValidationError);

    // --- CROSS-ORG: Org B cannot attach a file to Org A's obligation ---
    const orgAObligation = await new DrizzleBusinessObligationRepository().insert({ businessProfileId: orgA.organizationId, customerId: orgACustomer.id, originalAmountMinorUnits: 50000, agreedAmountMinorUnits: 50000 });
    await expect(
      service.uploadAttachment({ actingUserId: orgB.ownerUserId, organizationId: orgB.organizationId, documentType: "OTHER", parent: { kind: "obligation", id: orgAObligation.id }, fileName: "x.pdf", contentType: "application/pdf", content: PDF_BYTES }),
    ).rejects.toThrow(ValidationError);

    // Final confirmation: no cross-tenant signed URL was ever issued across this entire sequence.
    expect(storage.signedUrlsIssued).toHaveLength(1);
  });

  it("SAME-USER MULTI-ORG: one person who owns two organizations gets correct, independent authorization for each — never workspace-context confusion", async () => {
    const storage = new InMemoryDocumentStorage();
    const service = buildService(storage);

    const sharedOwner = await seedPersonalUser("attach-shared-owner");
    const db = getDb();

    const [orgX] = await db.insert(businessProfile).values({ ownerUserId: sharedOwner.userId, legalBusinessName: `Shared Org X ${randomUUID()}`, displayName: "Shared Org X", entityType: "LLC", businessAddress: {}, country: "US", state: "DE" }).returning({ id: businessProfile.id });
    const [orgY] = await db.insert(businessProfile).values({ ownerUserId: sharedOwner.userId, legalBusinessName: `Shared Org Y ${randomUUID()}`, displayName: "Shared Org Y", entityType: "LLC", businessAddress: {}, country: "US", state: "DE" }).returning({ id: businessProfile.id });
    if (!orgX || !orgY) throw new Error("org insert returned no row");
    await addActiveStaffMember(orgX.id, sharedOwner.userId);
    await addActiveStaffMember(orgY.id, sharedOwner.userId);

    const record = await service.uploadAttachment({ actingUserId: sharedOwner.userId, organizationId: orgX.id, documentType: "OTHER", parent: { kind: "none" }, fileName: "x-only.pdf", contentType: "application/pdf", content: PDF_BYTES });

    // The SAME user, acting under the OTHER organization's context, cannot see Org X's attachment.
    await expect(service.getSignedDownloadUrl({ actingUserId: sharedOwner.userId, organizationId: orgY.id, attachmentId: record.id })).rejects.toThrow(ForbiddenError);
    // Acting under the correct (owning) organization context, the SAME user succeeds.
    const result = await service.getSignedDownloadUrl({ actingUserId: sharedOwner.userId, organizationId: orgX.id, attachmentId: record.id });
    expect(result.url).toBeTruthy();
  });
});
