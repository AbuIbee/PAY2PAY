import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditService } from "@/lib/audit/auditService";
import { InMemoryAuditEventRepository } from "@/lib/auth/testFakes";
import { InMemoryAgreementRepository } from "@/lib/agreements/testFakes";
import { InMemoryDocumentStorage } from "@/lib/documents/testFakes";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { BasicAttachmentFileValidator, MAX_ATTACHMENT_FILE_SIZE_BYTES } from "./attachmentFileValidator";
import { BusinessAttachmentService } from "./businessAttachmentService";
import { InMemoryOrganizationDocumentRepository } from "./organizationDocumentTestFakes";
import { createTestOrganizationPermissionService, InMemoryBusinessCustomerRepository, InMemoryBusinessObligationRepository } from "./testFakes";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"

function createHarness() {
  const permCtx = createTestOrganizationPermissionService();
  const documents = new InMemoryOrganizationDocumentRepository();
  const storage = new InMemoryDocumentStorage();
  const auditRepo = new InMemoryAuditEventRepository();
  const audit = new AuditService(auditRepo);
  const agreements = new InMemoryAgreementRepository();
  const customers = new InMemoryBusinessCustomerRepository();
  const obligations = new InMemoryBusinessObligationRepository();
  const service = new BusinessAttachmentService({
    documents,
    storage,
    audit,
    permissions: permCtx.permissions,
    agreements,
    customers,
    obligations,
    fileValidator: new BasicAttachmentFileValidator(),
  });
  return { service, documents, storage, audit, auditRepo, agreements, customers, obligations, permCtx };
}

async function seedOrgWithMember(ctx: ReturnType<typeof createHarness>, permissions: string[]) {
  const organizationId = randomUUID();
  ctx.permCtx.businessProfiles.byId.set(organizationId, {
    id: organizationId,
    ownerUserId: "unused-owner",
    legalBusinessName: "Test LLC",
    displayName: "Test",
    entityType: "llc",
    status: "active",
    currency: "USD",
    createdAt: new Date(),
    dbaName: null,
    industry: null,
    formationJurisdiction: null,
    businessEmail: null,
    website: null,
    representative: null,
    onboardingStep: "billing_setup_complete",
  } as never);
  const userId = randomUUID();
  ctx.permCtx.staffMembers.seed({ businessProfileId: organizationId, userId, role: "VIEWER" });
  const role = await ctx.permCtx.roleService.createRole({
    organizationId,
    displayName: `Test Role ${randomUUID()}`,
    description: null,
    permissions: permissions.map((permissionKey) => ({ permissionKey, scope: "organization" as const })),
  });
  const membership = await ctx.permCtx.staffMembers.findActiveByBusinessAndUser(organizationId, userId);
  await ctx.permCtx.staffMembers.setRoleId(membership!.id, role.id);
  return { organizationId, userId };
}

describe("BusinessAttachmentService", () => {
  let ctx: ReturnType<typeof createHarness>;

  beforeEach(() => {
    ctx = createHarness();
  });

  describe("RBAC", () => {
    it("documents.upload denied for a member with only documents.view", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, ["documents.view"]);
      await expect(
        ctx.service.uploadAttachment({ actingUserId: userId, organizationId, documentType: "OTHER", parent: { kind: "none" }, fileName: "a.pdf", contentType: "application/pdf", content: PDF_BYTES }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("documents.view permits listing even without documents.upload", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, ["documents.view"]);
      const items = await ctx.service.listAttachments({ actingUserId: userId, organizationId, parent: { kind: "none" } });
      expect(items).toEqual([]);
    });

    it("no documents.view denies listing", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, []);
      await expect(ctx.service.listAttachments({ actingUserId: userId, organizationId, parent: { kind: "none" } })).rejects.toThrow(ForbiddenError);
    });

    it("a non-member of the organization is denied entirely", async () => {
      const { organizationId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      await expect(
        ctx.service.uploadAttachment({ actingUserId: randomUUID(), organizationId, documentType: "OTHER", parent: { kind: "none" }, fileName: "a.pdf", contentType: "application/pdf", content: PDF_BYTES }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("upload + parent resolution", () => {
    it("uploads an organization-general attachment (no parent) and records a safe audit event", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      const record = await ctx.service.uploadAttachment({
        actingUserId: userId,
        organizationId,
        documentType: "CONTRACT",
        parent: { kind: "none" },
        fileName: "../../etc/passwd.pdf",
        contentType: "application/pdf",
        content: PDF_BYTES,
      });
      expect(record.organizationId).toBe(organizationId);
      expect(record.relatedAgreementId).toBeNull();
      expect(record.relatedCustomerId).toBeNull();
      expect(record.relatedObligationId).toBeNull();
      // Path traversal sequences are stripped from the display filename (Section 13).
      expect(record.fileName).not.toContain("..");
      expect(record.fileName).not.toContain("/");

      expect(ctx.auditRepo.events).toHaveLength(1);
      const event = ctx.auditRepo.events[0]!;
      expect(event.action).toBe("BUSINESS_ATTACHMENT_UPLOADED");
      expect(event.profileId).toBe(organizationId);
      // Safe fields only — never a signed URL, raw secret, or file content (Section 20).
      expect(JSON.stringify(event.newValue)).not.toMatch(/https?:\/\//);
    });

    it("uploads an agreement-linked attachment only when the agreement genuinely belongs to this organization", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      const agreement = await ctx.agreements.insert({ creditorProfileKind: "business", creditorProfileId: organizationId, debtorProfileKind: "personal", debtorProfileId: randomUUID(), currency: "USD", createdByUserId: userId, organizationId });

      const record = await ctx.service.uploadAttachment({
        actingUserId: userId,
        organizationId,
        documentType: "INVOICE",
        parent: { kind: "agreement", id: agreement.id },
        fileName: "invoice.pdf",
        contentType: "application/pdf",
        content: PDF_BYTES,
      });
      expect(record.relatedAgreementId).toBe(agreement.id);
    });

    it("rejects an agreement id that does not belong to this organization", async () => {
      const { organizationId: orgA, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      const { organizationId: orgB } = await seedOrgWithMember(ctx, []);
      const agreementInOrgB = await ctx.agreements.insert({ creditorProfileKind: "business", creditorProfileId: orgB, debtorProfileKind: "personal", debtorProfileId: randomUUID(), currency: "USD", createdByUserId: userId, organizationId: orgB });

      await expect(
        ctx.service.uploadAttachment({ actingUserId: userId, organizationId: orgA, documentType: "INVOICE", parent: { kind: "agreement", id: agreementInOrgB.id }, fileName: "x.pdf", contentType: "application/pdf", content: PDF_BYTES }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a customer id that does not belong to this organization", async () => {
      const { organizationId: orgA, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      const { organizationId: orgB } = await seedOrgWithMember(ctx, []);
      const customerInOrgB = await ctx.customers.insert({ businessProfileId: orgB, counterpartyProfileKind: "personal", counterpartyProfileId: randomUUID() });

      await expect(
        ctx.service.uploadAttachment({ actingUserId: userId, organizationId: orgA, documentType: "OTHER", parent: { kind: "customer", id: customerInOrgB.id }, fileName: "x.pdf", contentType: "application/pdf", content: PDF_BYTES }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects an obligation id that does not belong to this organization", async () => {
      const { organizationId: orgA, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      const { organizationId: orgB } = await seedOrgWithMember(ctx, []);
      const customerInOrgB = await ctx.customers.insert({ businessProfileId: orgB, counterpartyProfileKind: "personal", counterpartyProfileId: randomUUID() });
      const obligationInOrgB = await ctx.obligations.insert({ businessProfileId: orgB, customerId: customerInOrgB.id, originalAmountMinorUnits: 1000, agreedAmountMinorUnits: 1000 });

      await expect(
        ctx.service.uploadAttachment({ actingUserId: userId, organizationId: orgA, documentType: "STATEMENT", parent: { kind: "obligation", id: obligationInOrgB.id }, fileName: "x.pdf", contentType: "application/pdf", content: PDF_BYTES }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("file validation", () => {
    it("rejects an unsupported MIME/extension", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      await expect(
        ctx.service.uploadAttachment({ actingUserId: userId, organizationId, documentType: "OTHER", parent: { kind: "none" }, fileName: "script.exe", contentType: "application/octet-stream", content: new Uint8Array([0x4d, 0x5a]) }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a dangerous executable disguised with a document extension", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      await expect(
        ctx.service.uploadAttachment({ actingUserId: userId, organizationId, documentType: "OTHER", parent: { kind: "none" }, fileName: "invoice.pdf", contentType: "application/pdf", content: new Uint8Array([0x4d, 0x5a, 0x00, 0x00]) }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects an oversized file", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      const oversized = new Uint8Array(MAX_ATTACHMENT_FILE_SIZE_BYTES + 1);
      oversized.set(PDF_BYTES);
      await expect(
        ctx.service.uploadAttachment({ actingUserId: userId, organizationId, documentType: "OTHER", parent: { kind: "none" }, fileName: "big.pdf", contentType: "application/pdf", content: oversized }),
      ).rejects.toThrow(ValidationError);
    });

    it("accepts a valid PDF", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      const record = await ctx.service.uploadAttachment({ actingUserId: userId, organizationId, documentType: "OTHER", parent: { kind: "none" }, fileName: "ok.pdf", contentType: "application/pdf", content: PDF_BYTES });
      expect(record.id).toBeTruthy();
    });

    it("accepts a valid PNG image", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const record = await ctx.service.uploadAttachment({ actingUserId: userId, organizationId, documentType: "OTHER", parent: { kind: "none" }, fileName: "photo.png", contentType: "image/png", content: png });
      expect(record.id).toBeTruthy();
    });
  });

  describe("storage key / client trust boundary", () => {
    it("the server derives the storage path — a client cannot control it (no storagePath/storageObjectKey input exists on the upload method at all)", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      const record = await ctx.service.uploadAttachment({ actingUserId: userId, organizationId, documentType: "OTHER", parent: { kind: "none" }, fileName: "a.pdf", contentType: "application/pdf", content: PDF_BYTES });
      expect(record.storagePath.startsWith(`organizations/${organizationId}/attachments/`)).toBe(true);
    });
  });

  describe("download / signed URL", () => {
    it("own-organization member receives a signed URL", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      const record = await ctx.service.uploadAttachment({ actingUserId: userId, organizationId, documentType: "OTHER", parent: { kind: "none" }, fileName: "a.pdf", contentType: "application/pdf", content: PDF_BYTES });

      const result = await ctx.service.getSignedDownloadUrl({ actingUserId: userId, organizationId, attachmentId: record.id });
      expect(result.url).toBeTruthy();
      expect(ctx.storage.signedUrlsIssued).toHaveLength(1);
    });

    it("cross-organization request is denied BEFORE createSignedUrl is ever invoked", async () => {
      const { organizationId: orgA, userId: userA } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      const { organizationId: orgB, userId: userB } = await seedOrgWithMember(ctx, ["documents.view"]);
      const record = await ctx.service.uploadAttachment({ actingUserId: userA, organizationId: orgA, documentType: "OTHER", parent: { kind: "none" }, fileName: "a.pdf", contentType: "application/pdf", content: PDF_BYTES });

      await expect(ctx.service.getSignedDownloadUrl({ actingUserId: userB, organizationId: orgB, attachmentId: record.id })).rejects.toThrow(ForbiddenError);
      expect(ctx.storage.signedUrlsIssued).toHaveLength(0);
    });
  });

  describe("storage failure behavior", () => {
    it("a storage upload failure never results in a persisted metadata row (no false success)", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      const failingStorage = { uploadPrivate: () => Promise.reject(new Error("storage unavailable")), createSignedUrl: () => Promise.reject(new Error("unused")) };
      const brokenService = new BusinessAttachmentService({
        documents: ctx.documents,
        storage: failingStorage,
        audit: ctx.audit,
        permissions: ctx.permCtx.permissions,
        agreements: ctx.agreements,
        customers: ctx.customers,
        obligations: ctx.obligations,
        fileValidator: new BasicAttachmentFileValidator(),
      });
      await expect(
        brokenService.uploadAttachment({ actingUserId: userId, organizationId, documentType: "OTHER", parent: { kind: "none" }, fileName: "a.pdf", contentType: "application/pdf", content: PDF_BYTES }),
      ).rejects.toThrow("storage unavailable");
      expect(await ctx.documents.listForOrganization(organizationId)).toHaveLength(0);
    });

    it("a signed-URL generation failure never returns a false URL", async () => {
      const { organizationId, userId } = await seedOrgWithMember(ctx, ["documents.view", "documents.upload"]);
      const record = await ctx.service.uploadAttachment({ actingUserId: userId, organizationId, documentType: "OTHER", parent: { kind: "none" }, fileName: "a.pdf", contentType: "application/pdf", content: PDF_BYTES });
      const failingStorage = { uploadPrivate: ctx.storage.uploadPrivate.bind(ctx.storage), createSignedUrl: () => Promise.reject(new Error("signing unavailable")) };
      const brokenService = new BusinessAttachmentService({
        documents: ctx.documents,
        storage: failingStorage,
        audit: ctx.audit,
        permissions: ctx.permCtx.permissions,
        agreements: ctx.agreements,
        customers: ctx.customers,
        obligations: ctx.obligations,
        fileValidator: new BasicAttachmentFileValidator(),
      });
      await expect(brokenService.getSignedDownloadUrl({ actingUserId: userId, organizationId, attachmentId: record.id })).rejects.toThrow("signing unavailable");
    });
  });
});
