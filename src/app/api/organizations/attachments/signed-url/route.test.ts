import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { withErrorHandling } from "@/lib/api-handler";
import { TEST_ADULT_DATE_OF_BIRTH, TEST_SIGNUP_IDENTITY, createTestAuthService } from "@/lib/auth/testFakes";
import { AuditService } from "@/lib/audit/auditService";
import { InMemoryAuditEventRepository } from "@/lib/auth/testFakes";
import { InMemoryAgreementRepository } from "@/lib/agreements/testFakes";
import { InMemoryDocumentStorage } from "@/lib/documents/testFakes";
import { BasicAttachmentFileValidator } from "@/lib/organizations/attachmentFileValidator";
import { BusinessAttachmentService } from "@/lib/organizations/businessAttachmentService";
import { InMemoryOrganizationDocumentRepository } from "@/lib/organizations/organizationDocumentTestFakes";
import { InMemoryBusinessCustomerRepository, InMemoryBusinessObligationRepository, createTestOrganizationPermissionService } from "@/lib/organizations/testFakes";
import { createAttachmentSignedUrlHandler } from "./route";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

describe("GET /api/organizations/attachments/signed-url", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let storage: InMemoryDocumentStorage;
  let attachments: BusinessAttachmentService;
  let organizationId: string;
  let otherOrganizationId: string;
  let ownerUserId: string;
  let ownerToken: string;
  let attachmentId: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    orgCtx = createTestOrganizationPermissionService();
    storage = new InMemoryDocumentStorage();
    attachments = new BusinessAttachmentService({
      documents: new InMemoryOrganizationDocumentRepository(),
      storage,
      audit: new AuditService(new InMemoryAuditEventRepository()),
      permissions: orgCtx.permissions,
      agreements: new InMemoryAgreementRepository(),
      customers: new InMemoryBusinessCustomerRepository(),
      obligations: new InMemoryBusinessObligationRepository(),
      fileValidator: new BasicAttachmentFileValidator(),
    });

    const result = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "owner@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    ownerUserId = result.user.id;
    ownerToken = result.token;

    const org = await orgCtx.businessProfiles.insert({ ownerUserId, legalBusinessName: "ABC Trucking LLC", displayName: "ABC Trucking", entityType: "LLC", businessAddress: {}, country: "US", state: "DE" });
    organizationId = org.id;
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: ownerUserId, role: "OWNER", customRoleId: null, isAuthorizedRepresentative: true });
    await orgCtx.legacyMigration.migrateOrganization(organizationId);

    const otherOrg = await orgCtx.businessProfiles.insert({ ownerUserId, legalBusinessName: "Other LLC", displayName: "Other", entityType: "LLC", businessAddress: {}, country: "US", state: "DE" });
    otherOrganizationId = otherOrg.id;

    const record = await attachments.uploadAttachment({
      actingUserId: ownerUserId,
      organizationId,
      documentType: "OTHER",
      parent: { kind: "none" },
      fileName: "secret.pdf",
      contentType: "application/pdf",
      content: PDF_BYTES,
    });
    attachmentId = record.id;
  });

  function handler() {
    return withErrorHandling("test", createAttachmentSignedUrlHandler(authCtx.authService, attachments));
  }

  function request(query: string, token?: string) {
    return new NextRequest(`http://localhost/api/organizations/attachments/signed-url?${query}`, {
      headers: token ? { cookie: `p2p_session=${token}` } : {},
    });
  }

  it("the own-organization OWNER receives a signed URL", async () => {
    const response = await handler()(request(`organizationId=${organizationId}&attachmentId=${attachmentId}`, ownerToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    expect(body.url).toBeTruthy();
    expect(storage.signedUrlsIssued).toHaveLength(1);
  });

  it("a DIFFERENT organization's member (same human, different org) is denied, and createSignedUrl is never invoked", async () => {
    await orgCtx.staffMembers.insert({ businessProfileId: otherOrganizationId, userId: ownerUserId, role: "OWNER", customRoleId: null, isAuthorizedRepresentative: true });
    await orgCtx.legacyMigration.migrateOrganization(otherOrganizationId);

    const response = await handler()(request(`organizationId=${otherOrganizationId}&attachmentId=${attachmentId}`, ownerToken));
    expect(response.status).toBe(403);
    expect(storage.signedUrlsIssued).toHaveLength(0);
  });

  it("a non-member is denied with 403, and createSignedUrl is never invoked", async () => {
    const outsider = await authCtx.authService.signup({
      accountType: "personal",
      identity: TEST_SIGNUP_IDENTITY,
      inviteCode: null,
      email: "outsider@example.com",
      password: "a-strong-password",
      dateOfBirth: TEST_ADULT_DATE_OF_BIRTH,
      ipAddress: null,
      userAgent: null,
    });
    const response = await handler()(request(`organizationId=${organizationId}&attachmentId=${attachmentId}`, outsider.token));
    expect(response.status).toBe(403);
    expect(storage.signedUrlsIssued).toHaveLength(0);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const response = await handler()(request(`organizationId=${organizationId}&attachmentId=${attachmentId}`));
    expect(response.status).toBe(401);
  });
});
