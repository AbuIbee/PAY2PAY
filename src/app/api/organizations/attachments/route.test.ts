// @vitest-environment node
//
// "PAID2YOU — SECURE BUSINESS ATTACHMENTS ITERATION" (2026-10-05): this is the first multipart
// file-upload route test in this codebase (the pre-existing evidence-upload route has no dedicated
// route.test.ts either). jsdom's own global FormData/File/Request do not round-trip through
// NextRequest.formData() as multipart (its Content-Type falls back to "text/plain", and
// req.formData() then throws) — confirmed by direct reproduction, not assumed. This file-level
// pragma runs ONLY this test file under Vitest's Node environment instead, where native
// undici-backed FormData/File/Request work correctly; every other test file in this project is
// unaffected.
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
import { createAttachmentListHandler, createAttachmentUploadHandler } from "./route";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

describe("POST/GET /api/organizations/attachments", () => {
  let authCtx: ReturnType<typeof createTestAuthService>;
  let orgCtx: ReturnType<typeof createTestOrganizationPermissionService>;
  let attachments: BusinessAttachmentService;
  let organizationId: string;
  let ownerUserId: string;
  let ownerToken: string;

  beforeEach(async () => {
    authCtx = createTestAuthService();
    orgCtx = createTestOrganizationPermissionService();
    attachments = new BusinessAttachmentService({
      documents: new InMemoryOrganizationDocumentRepository(),
      storage: new InMemoryDocumentStorage(),
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

    const org = await orgCtx.businessProfiles.insert({
      ownerUserId,
      legalBusinessName: "ABC Trucking LLC",
      displayName: "ABC Trucking",
      entityType: "LLC",
      businessAddress: {},
      country: "US",
      state: "DE",
    });
    organizationId = org.id;
    await orgCtx.staffMembers.insert({ businessProfileId: organizationId, userId: ownerUserId, role: "OWNER", customRoleId: null, isAuthorizedRepresentative: true });
    await orgCtx.legacyMigration.migrateOrganization(organizationId);
  });

  function uploadHandler() {
    return withErrorHandling("test", createAttachmentUploadHandler(authCtx.authService, attachments));
  }

  function listHandler() {
    return withErrorHandling("test", createAttachmentListHandler(authCtx.authService, attachments, orgCtx.permissions));
  }

  function uploadRequest(formData: FormData, token?: string) {
    return new NextRequest("http://localhost/api/organizations/attachments", {
      method: "POST",
      body: formData,
      headers: token ? { cookie: `p2p_session=${token}` } : {},
    });
  }

  function listRequest(query: string, token?: string) {
    return new NextRequest(`http://localhost/api/organizations/attachments?${query}`, {
      headers: token ? { cookie: `p2p_session=${token}` } : {},
    });
  }

  it("OWNER can upload an organization-general attachment, and the server assigns a safe storage path", async () => {
    const formData = new FormData();
    formData.set("organizationId", organizationId);
    formData.set("documentType", "CONTRACT");
    formData.set("parentKind", "none");
    formData.set("file", new File([PDF_BYTES], "contract.pdf", { type: "application/pdf" }));

    const response = await uploadHandler()(uploadRequest(formData, ownerToken));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; fileName: string };
    expect(body.id).toBeTruthy();
    expect(body.fileName).toBe("contract.pdf");
  });

  it("rejects an upload with no file", async () => {
    const formData = new FormData();
    formData.set("organizationId", organizationId);
    formData.set("documentType", "OTHER");
    formData.set("parentKind", "none");

    const response = await uploadHandler()(uploadRequest(formData, ownerToken));
    expect(response.status).toBe(400);
  });

  it("rejects an unauthenticated upload with 401", async () => {
    const formData = new FormData();
    formData.set("organizationId", organizationId);
    formData.set("documentType", "OTHER");
    formData.set("parentKind", "none");
    formData.set("file", new File([PDF_BYTES], "a.pdf", { type: "application/pdf" }));

    const response = await uploadHandler()(uploadRequest(formData));
    expect(response.status).toBe(401);
  });

  it("denies upload for a non-member with 403, and lists zero items for them", async () => {
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

    const formData = new FormData();
    formData.set("organizationId", organizationId);
    formData.set("documentType", "OTHER");
    formData.set("parentKind", "none");
    formData.set("file", new File([PDF_BYTES], "a.pdf", { type: "application/pdf" }));
    const uploadResponse = await uploadHandler()(uploadRequest(formData, outsider.token));
    expect(uploadResponse.status).toBe(403);

    const listResponse = await listHandler()(listRequest(`organizationId=${organizationId}`, outsider.token));
    expect(listResponse.status).toBe(403);
  });

  it("GET lists uploaded attachments and reports canUpload truthfully for the OWNER", async () => {
    const formData = new FormData();
    formData.set("organizationId", organizationId);
    formData.set("documentType", "STATEMENT");
    formData.set("parentKind", "none");
    formData.set("file", new File([PDF_BYTES], "statement.pdf", { type: "application/pdf" }));
    await uploadHandler()(uploadRequest(formData, ownerToken));

    const response = await listHandler()(listRequest(`organizationId=${organizationId}`, ownerToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { canUpload: boolean; items: Array<{ fileName: string }> };
    expect(body.canUpload).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.fileName).toBe("statement.pdf");
  });
});
