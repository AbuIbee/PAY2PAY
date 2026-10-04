import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ValidationError } from "@/lib/errors";
import type { BusinessVerificationRecord, BusinessVerificationRepository } from "./businessVerificationRepository";
import type { BusinessVerificationProvider, SubmitBusinessVerificationInput } from "./businessVerificationProvider";

/** "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 5: SCREAMING_SNAKE_CASE, mirrors the existing RBAC audit-action-naming convention (ROLE_CREATED, MEMBER_INVITED, etc. — organizationAuditedMutationsDrizzle.ts). */
const BUSINESS_VERIFICATION_AUDIT_ACTION = {
  SUBMITTED: "BUSINESS_VERIFICATION_SUBMITTED",
  REVIEW_REQUIRED: "BUSINESS_VERIFICATION_REVIEW_REQUIRED",
  APPROVED: "BUSINESS_VERIFICATION_APPROVED",
  REJECTED: "BUSINESS_VERIFICATION_REJECTED",
} as const;

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 9: the one seam that ever touches a raw Tax
 * ID/EIN. Audited this repository for an existing sensitive-field encryption facility (Section 9's
 * own instruction) and found none (`src/lib/payments/paymentProvider.ts`'s only "encrypt" mention is
 * an unrelated doc comment about bank-detail tokenization, not a reusable field-encryption utility).
 * Per Section 9's own fallback rule ("do not invent weak custom crypto"), this service does not
 * invent one either — it simply never persists the raw value at all: `taxId` is read from the caller
 * once, passed straight through to `BusinessVerificationProvider.submitVerification` (the only place
 * it is ever sent anywhere), and only `taxIdLast4` (derived from it right here, in memory) is ever
 * written to `business_verification`. No column in this application's schema can hold a raw EIN.
 *
 * `status` starts, and stays, "pending" until `applyVerificationResult` (called from a real webhook
 * or a polled `retrieveVerificationStatus`) reports an actual provider decision — never fabricated,
 * never auto-approved (Requirement 29: VERIFIED is never inferred from submission alone). "PAID2YOU
 * — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 5: every material lifecycle transition is
 * now also recorded through the existing AuditService — never a second, competing audit mechanism.
 * The audit payload NEVER contains the raw EIN/TIN, a provider API key, or a webhook secret — only
 * safe fields already present on `BusinessVerificationRecord` (status, taxIdLast4, failureCode).
 */
export class BusinessVerificationService {
  constructor(
    private readonly provider: BusinessVerificationProvider,
    private readonly verifications: BusinessVerificationRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * `actorUserId` is the authenticated caller who initiated this submission (threaded through from
   * BusinessOnboardingService, which already enforces organization ownership before calling this) —
   * never trusted from anywhere inside `input` itself, which carries no actor identity.
   */
  async submit(actorUserId: string, input: SubmitBusinessVerificationInput): Promise<BusinessVerificationRecord> {
    if (input.taxId.trim().length < 4) {
      throw new ValidationError("A valid Tax ID/EIN is required.");
    }
    const taxIdLast4 = input.taxId.trim().slice(-4);
    const result = await this.provider.submitVerification(input);
    const record = await this.verifications.insertSubmission({
      organizationId: input.organizationId,
      provider: this.provider.providerName,
      providerReference: result.providerReference,
      taxIdLast4,
    });
    await this.audit.record(
      this.auditPayload({
        actorUserId,
        actorRole: "business_staff",
        organizationId: input.organizationId,
        action: BUSINESS_VERIFICATION_AUDIT_ACTION.SUBMITTED,
        newValue: { status: record.status, taxIdLast4: record.taxIdLast4, provider: record.provider },
        providerEventId: null,
      }),
    );
    return record;
  }

  async getLatestStatus(organizationId: string): Promise<BusinessVerificationRecord | null> {
    return this.verifications.findLatestForOrganization(organizationId);
  }

  /**
   * Invoked by a verified webhook delivery or a polled retrieveVerificationStatus call — never by
   * any code path that could fabricate a result. `providerEventId`, when the caller is a webhook
   * (never set for a manual poll), is recorded on the resulting audit event for idempotent-replay
   * defense-in-depth — the webhook SERVICE layer (BusinessVerificationWebhookService) already
   * dedupes by (provider, providerEventId) before ever calling this method a second time for the
   * same delivery, so this is a second, independent safety net, not the only one.
   */
  async applyVerificationResult(providerReference: string, providerEventId: string | null = null): Promise<BusinessVerificationRecord> {
    const existing = await this.verifications.findByProviderReference(providerReference);
    if (!existing) throw new ValidationError("Unknown business verification reference.");
    // Snapshotted into a primitive BEFORE calling applyResult below — some repository
    // implementations (e.g. the in-memory test fake) mutate the SAME object `existing` points at
    // in place, which would otherwise silently make `existing.status` read as the NEW status too,
    // masking every transition from ever being detected.
    const previousStatus = existing.status;

    const result = await this.provider.retrieveVerificationStatus(providerReference);
    await this.verifications.applyResult(existing.id, {
      status: result.status,
      legalNameResult: result.legalNameResult ?? null,
      taxIdResult: result.taxIdResult ?? null,
      addressResult: result.addressResult ?? null,
      representativeResult: result.representativeResult ?? null,
      failureCode: result.failureCode ?? null,
      reviewRequired: result.reviewRequired ?? false,
      verifiedAt: result.status === "verified" ? new Date() : null,
    });
    const updated = await this.verifications.findByProviderReference(providerReference);
    if (!updated) throw new ValidationError("Business verification record disappeared during update.");

    // Only a genuine status CHANGE is audited — a redundant poll/webhook that reports the SAME
    // status this organization already has recorded is not a new material event (Section 5's own
    // "do not create duplicate audit events on webhook replay", applied here to the broader case of
    // any redundant re-apply, not merely an exact-duplicate delivery).
    if (updated.status !== previousStatus) {
      const action =
        updated.status === "verified"
          ? BUSINESS_VERIFICATION_AUDIT_ACTION.APPROVED
          : updated.status === "rejected"
            ? BUSINESS_VERIFICATION_AUDIT_ACTION.REJECTED
            : updated.status === "review_required"
              ? BUSINESS_VERIFICATION_AUDIT_ACTION.REVIEW_REQUIRED
              : null;
      if (action) {
        await this.audit.record(
          this.auditPayload({
            actorUserId: null,
            actorRole: "middesk_webhook",
            organizationId: updated.organizationId,
            action,
            newValue: { status: updated.status, failureCode: updated.failureCode },
            previousValue: { status: previousStatus },
            providerEventId,
          }),
        );
      }
    }
    return updated;
  }

  private auditPayload(input: {
    actorUserId: string | null;
    actorRole: string;
    organizationId: string;
    action: string;
    newValue: unknown;
    previousValue?: unknown;
    providerEventId: string | null;
  }) {
    return {
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      profileKind: "business" as const,
      profileId: input.organizationId,
      agreementId: null,
      action: input.action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: input.previousValue ?? null,
      newValue: input.newValue,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: null,
      providerEventId: input.providerEventId,
    };
  }
}
