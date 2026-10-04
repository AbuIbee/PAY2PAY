import { describe, expect, it } from "vitest";
import { AuditService } from "@/lib/audit/auditService";
import { InMemoryAuditEventRepository } from "@/lib/auth/testFakes";
import { ProviderNotAvailableError } from "@/lib/errors";
import { SandboxBusinessVerificationProvider } from "@/test-support/organizations/sandboxBusinessVerificationProvider";
import { assertProviderAvailableForRuntime } from "@/lib/providers/providerCapabilities";
import { BusinessVerificationService } from "./businessVerificationService";
import { InMemoryBusinessVerificationRepository } from "./businessVerificationTestFakes";

const representative = {
  firstName: "Jane",
  lastName: "Doe",
  title: "CEO",
  email: "jane@example.com",
  phone: "+15555550100",
  relationshipToBusiness: "Owner",
};

const ACTOR_USER_ID = "user-1";

function buildService() {
  const provider = new SandboxBusinessVerificationProvider("test-webhook-secret");
  const verifications = new InMemoryBusinessVerificationRepository();
  const auditRepo = new InMemoryAuditEventRepository();
  const audit = new AuditService(auditRepo);
  return { service: new BusinessVerificationService(provider, verifications, audit), provider, verifications, auditRepo };
}

describe("BusinessVerificationService (Section 9)", () => {
  it("NOT_CONFIGURED production behavior: no business_verification provider is registered, so the factory fails closed", () => {
    expect(() => assertProviderAvailableForRuntime("business_verification", undefined, "production")).toThrow(ProviderNotAvailableError);
  });

  it("submitting never auto-verifies — status starts and stays pending until a real result arrives (fake provider success path)", async () => {
    const { service } = buildService();
    const record = await service.submit(ACTOR_USER_ID, {
      organizationId: "org-1",
      legalBusinessName: "ABC Trucking LLC",
      entityType: "LLC",
      taxId: "123456789",
      formationJurisdiction: "DE",
      businessAddress: { line1: "1 Main St", city: "Dover", state: "DE", postalCode: "19901" },
      representative,
    });
    expect(record.status).toBe("pending");
    expect(record.taxIdLast4).toBe("6789");
  });

  it("never persists the raw Tax ID anywhere in the resulting record", async () => {
    const { service } = buildService();
    const record = await service.submit(ACTOR_USER_ID, {
      organizationId: "org-1",
      legalBusinessName: "ABC Trucking LLC",
      entityType: "LLC",
      taxId: "987654321",
      formationJurisdiction: "DE",
      businessAddress: {},
      representative,
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("987654321");
    expect(record.taxIdLast4).toBe("4321");
  });

  it("applying a verified result (simulated provider decision) updates status without any application code fabricating it", async () => {
    const { service, provider } = buildService();
    const record = await service.submit(ACTOR_USER_ID, {
      organizationId: "org-1",
      legalBusinessName: "ABC Trucking LLC",
      entityType: "LLC",
      taxId: "123456789",
      formationJurisdiction: "DE",
      businessAddress: {},
      representative,
    });
    provider.simulateDecision(record.providerReference!, "verified");
    const updated = await service.applyVerificationResult(record.providerReference!);
    expect(updated.status).toBe("verified");
    expect(updated.verifiedAt).not.toBeNull();
  });

  it("organization isolation: findLatestForOrganization never returns another organization's verification", async () => {
    const { service } = buildService();
    await service.submit(ACTOR_USER_ID, {
      organizationId: "org-a",
      legalBusinessName: "A LLC",
      entityType: "LLC",
      taxId: "111111111",
      formationJurisdiction: "DE",
      businessAddress: {},
      representative,
    });
    const forB = await service.getLatestStatus("org-b");
    expect(forB).toBeNull();
  });

  describe("PAID2YOU — MASTER P0 CLOSURE REMEDIATION (2026-10-03), Section 5: verification audit events", () => {
    it("records BUSINESS_VERIFICATION_SUBMITTED with the real actor, never the raw Tax ID", async () => {
      const { service, auditRepo } = buildService();
      await service.submit(ACTOR_USER_ID, {
        organizationId: "org-audit-1",
        legalBusinessName: "ABC Trucking LLC",
        entityType: "LLC",
        taxId: "555667777",
        formationJurisdiction: "DE",
        businessAddress: {},
        representative,
      });
      const submitted = auditRepo.events.filter((e) => e.action === "BUSINESS_VERIFICATION_SUBMITTED");
      expect(submitted).toHaveLength(1);
      expect(submitted[0]?.actorUserId).toBe(ACTOR_USER_ID);
      expect(submitted[0]?.profileId).toBe("org-audit-1");
      expect(JSON.stringify(submitted[0])).not.toContain("555667777");
    });

    it("records BUSINESS_VERIFICATION_APPROVED on a verified transition, with a server-controlled actor (not the submitting user)", async () => {
      const { service, provider, auditRepo } = buildService();
      const record = await service.submit(ACTOR_USER_ID, {
        organizationId: "org-audit-2",
        legalBusinessName: "ABC Trucking LLC",
        entityType: "LLC",
        taxId: "123456789",
        formationJurisdiction: "DE",
        businessAddress: {},
        representative,
      });
      provider.simulateDecision(record.providerReference!, "verified");
      await service.applyVerificationResult(record.providerReference!);

      const approved = auditRepo.events.filter((e) => e.action === "BUSINESS_VERIFICATION_APPROVED");
      expect(approved).toHaveLength(1);
      expect(approved[0]?.actorUserId).toBeNull();
      expect(approved[0]?.actorRole).toBe("middesk_webhook");
    });

    it("records no audit event at all when the status does not actually change (e.g. re-applying while still pending)", async () => {
      const { service, auditRepo } = buildService();
      const record = await service.submit(ACTOR_USER_ID, {
        organizationId: "org-audit-3",
        legalBusinessName: "ABC Trucking LLC",
        entityType: "LLC",
        taxId: "123456789",
        formationJurisdiction: "DE",
        businessAddress: {},
        representative,
      });
      // Still "pending" (no simulateDecision call) — re-applying should not record a transition event.
      await service.applyVerificationResult(record.providerReference!);
      const transitionEvents = auditRepo.events.filter((e) => e.action !== "BUSINESS_VERIFICATION_SUBMITTED");
      expect(transitionEvents).toHaveLength(0);
    });
  });
});
