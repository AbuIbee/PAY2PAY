import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { DraftTermsInput } from "@/lib/agreements/agreementService";
import { InMemoryPersonalProfileRepository } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { grantStepUp } from "@/lib/staff/testFakes";
import { InMemoryDocumentStorage, InMemoryProfileDisplayReader } from "@/lib/documents/testFakes";
import { SignatureService } from "@/lib/signatures/signatureService";
import { InMemoryAgreementPdfRepository, InMemorySignatureEventRepository } from "@/lib/signatures/testFakes";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { createTestB2BWorkflowService, markBusinessFullyVerified, markProfileFullyVerified } from "./testFakes";

function baseTerms(overrides: Partial<DraftTermsInput> = {}): DraftTermsInput {
  return {
    category: "b2b_receivable",
    description: "Wholesale supply invoice",
    originalAmountMinorUnits: 500_000,
    previousPaymentsMinorUnits: 0,
    firstPaymentMinorUnits: 100_000,
    installmentAmountMinorUnits: 100_000,
    frequency: "monthly",
    firstPaymentDate: "2026-02-01",
    feeAllocation: "split_evenly",
    earlyPayoffTerms: "No penalty for early payoff.",
    hardshipRules: "Hardship relief available upon request.",
    partialPaymentRules: "Partial payments require creditor approval.",
    settlementRules: "Settlement may be proposed by either party.",
    disputeProcedure: "Disputes are handled per platform policy.",
    ...overrides,
  };
}

class SimpleAuditRepo implements AuditEventRepository {
  events: AuditEventRecord[] = [];
  private nextId = 1;
  async getLastEvent() {
    return this.events.at(-1) ?? null;
  }
  async insertEvent(record: Omit<AuditEventRecord, "id">) {
    const stored = { ...record, id: this.nextId++ };
    this.events.push(stored);
    return stored;
  }
}

describe("B2BWorkflowService", () => {
  let ctx: ReturnType<typeof createTestB2BWorkflowService>;

  beforeEach(() => {
    ctx = createTestB2BWorkflowService();
  });

  async function seedBusiness(): Promise<{ businessId: string; ownerId: string }> {
    const ownerId = randomUUID();
    const businessId = randomUUID();
    ctx.agreementCtx.profileOwners.set("business", businessId, ownerId);
    await markBusinessFullyVerified(ctx, businessId);
    return { businessId, ownerId };
  }

  describe("B2B authorization", () => {
    it("rejects a draft where either side is a personal profile", async () => {
      const creditor = await seedBusiness();
      const debtorPersonalId = randomUUID();
      const debtorUserId = randomUUID();
      ctx.agreementCtx.profileOwners.set("personal", debtorPersonalId, debtorUserId);

      await expect(
        ctx.b2bWorkflowService.createB2BDraft({
          creatorUserId: creditor.ownerId,
          creditor: { kind: "business", id: creditor.businessId },
          debtor: { kind: "personal", id: debtorPersonalId },
          ...baseTerms(),
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a draft where either business is not FULL_VERIFIED", async () => {
      const creditor = await seedBusiness();
      const debtorOwnerId = randomUUID();
      const debtorBusinessId = randomUUID();
      ctx.agreementCtx.profileOwners.set("business", debtorBusinessId, debtorOwnerId);
      // Deliberately not verified.

      await expect(
        ctx.b2bWorkflowService.createB2BDraft({
          creatorUserId: creditor.ownerId,
          creditor: { kind: "business", id: creditor.businessId },
          debtor: { kind: "business", id: debtorBusinessId },
          ...baseTerms(),
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("creates a B2B draft with references when both sides are verified businesses", async () => {
      const creditor = await seedBusiness();
      const debtor = await seedBusiness();

      const result = await ctx.b2bWorkflowService.createB2BDraft({
        creatorUserId: creditor.ownerId,
        creditor: { kind: "business", id: creditor.businessId },
        debtor: { kind: "business", id: debtor.businessId },
        ...baseTerms(),
        references: [{ referenceType: "invoice", referenceNumber: "INV-1001" }],
      });
      expect(result.agreement.status).toBe("draft");
      const references = await ctx.references.listForAgreement(result.agreement.id);
      expect(references).toHaveLength(1);
      expect(references[0]?.referenceNumber).toBe("INV-1001");
    });

    it("rejects adding a reference from a non-party, and allows a party", async () => {
      const creditor = await seedBusiness();
      const debtor = await seedBusiness();
      const result = await ctx.b2bWorkflowService.createB2BDraft({
        creatorUserId: creditor.ownerId,
        creditor: { kind: "business", id: creditor.businessId },
        debtor: { kind: "business", id: debtor.businessId },
        ...baseTerms(),
      });

      const stranger = randomUUID();
      await expect(
        ctx.b2bWorkflowService.addReference({
          agreementId: result.agreement.id,
          actingUserId: stranger,
          referenceType: "purchase_order",
          referenceNumber: "PO-1",
        }),
      ).rejects.toThrow(ForbiddenError);

      const added = await ctx.b2bWorkflowService.addReference({
        agreementId: result.agreement.id,
        actingUserId: debtor.ownerId,
        referenceType: "purchase_order",
        referenceNumber: "PO-1",
      });
      expect(added.referenceNumber).toBe("PO-1");

      await expect(ctx.b2bWorkflowService.listReferences(result.agreement.id, stranger)).rejects.toThrow(ForbiddenError);
      const list = await ctx.b2bWorkflowService.listReferences(result.agreement.id, creditor.ownerId);
      expect(list).toHaveLength(1);
    });
  });

  describe("signer authority", () => {
    it("a fully-signed B2B agreement (both sides business) correctly captures each signer's title and authority", async () => {
      const creditor = await seedBusiness();
      const debtor = await seedBusiness();
      const draft = await ctx.b2bWorkflowService.createB2BDraft({
        creatorUserId: creditor.ownerId,
        creditor: { kind: "business", id: creditor.businessId },
        debtor: { kind: "business", id: debtor.businessId },
        ...baseTerms(),
      });
      await ctx.agreementCtx.agreementService.submitDraft(draft.agreement.id, creditor.ownerId);
      await ctx.agreementCtx.agreementService.acknowledgeDebt(draft.agreement.id, debtor.ownerId);
      await ctx.agreementCtx.agreementService.creditorDecide({
        agreementId: draft.agreement.id,
        actingUserId: creditor.ownerId,
        decision: "accept",
      });

      // Build a SignatureService sharing this test's agreementCtx/profileOwners/staffService/verification.
      const personalProfiles = new InMemoryPersonalProfileRepository();
      const { mfaService, credentials: mfaCredentials, stepUps } = createTestMfaService();
      const signatureEvents = new InMemorySignatureEventRepository();
      const signatureService = new SignatureService({
        agreementService: ctx.agreementCtx.agreementService,
        mfa: mfaService,
        verification: ctx.verificationService, // same VerificationService instance the B2B gate uses
        staffService: ctx.agreementCtx.staffCtx.staffService,
        personalProfiles,
        profileOwners: ctx.agreementCtx.profileOwners,
        signatureEvents,
        agreementPdfs: new InMemoryAgreementPdfRepository(),
        profileDisplay: new InMemoryProfileDisplayReader(),
        storage: new InMemoryDocumentStorage(),
        audit: new AuditService(new SimpleAuditRepo()),
      });

      async function readySigner(ownerId: string, sessionId: string) {
        await grantStepUp({ mfaCredentials, stepUps }, ownerId, sessionId);
        const profile = await personalProfiles.insert(ownerId);
        ctx.agreementCtx.profileOwners.set("personal", profile.id, ownerId);
        await markProfileFullyVerified(ctx, "personal", profile.id);
      }

      const creditorSession = randomUUID();
      const debtorSession = randomUUID();
      await readySigner(creditor.ownerId, creditorSession);
      await readySigner(debtor.ownerId, debtorSession);

      await signatureService.sign({
        agreementId: draft.agreement.id,
        actingUserId: creditor.ownerId,
        actingSessionId: creditorSession,
        authMethod: "totp",
        consentVersion: "v1",
        timezone: "America/New_York",
        deviceInfo: null,
        ipAddress: "203.0.113.1",
      });
      const result = await signatureService.sign({
        agreementId: draft.agreement.id,
        actingUserId: debtor.ownerId,
        actingSessionId: debtorSession,
        authMethod: "totp",
        consentVersion: "v1",
        timezone: "America/New_York",
        deviceInfo: null,
        ipAddress: "203.0.113.2",
      });

      expect(result.agreementStatus).toBe("first_payment_pending");
      const events = await signatureEvents.listForVersion(draft.version.id);
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event.signingAuthority).toBe("account_owner"); // both signed as their business's own owner
      }
    });
  });

  describe("tenant isolation", () => {
    it("a business unrelated to the agreement cannot add or view references", async () => {
      const creditor = await seedBusiness();
      const debtor = await seedBusiness();
      const outsider = await seedBusiness();
      const result = await ctx.b2bWorkflowService.createB2BDraft({
        creatorUserId: creditor.ownerId,
        creditor: { kind: "business", id: creditor.businessId },
        debtor: { kind: "business", id: debtor.businessId },
        ...baseTerms(),
      });

      await expect(
        ctx.b2bWorkflowService.addReference({
          agreementId: result.agreement.id,
          actingUserId: outsider.ownerId,
          referenceType: "contract",
          referenceNumber: "C-1",
        }),
      ).rejects.toThrow(ForbiddenError);
      await expect(ctx.b2bWorkflowService.listReferences(result.agreement.id, outsider.ownerId)).rejects.toThrow(
        ForbiddenError,
      );
    });
  });
});
