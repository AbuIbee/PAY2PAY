import "server-only";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 9: mirrors src/lib/kyc/kycProvider.ts's own
 * shape (submit -> opaque provider reference; retrieve/webhook -> status) — a deliberately SEPARATE
 * interface from `KycKybProvider`, not a reuse of it, since business verification here is scoped to
 * Requirement 3's exact business-onboarding fields (legal name, entity type, Tax ID/EIN, formation
 * jurisdiction, address, authorized representative), not individual KYC/KYB.
 *
 * The raw Tax ID is accepted here and passed straight through to the real provider — it is NEVER
 * returned, logged, or exposed by any implementation of this interface; only `taxIdLast4` (computed
 * by the caller from the input it already has, not derived from anything this interface returns) and
 * the provider's own opaque reference/result codes are ever persisted (see businessVerificationService.ts).
 */
export interface BusinessRepresentativeInput {
  firstName: string;
  lastName: string;
  title: string;
  email: string;
  phone: string;
  relationshipToBusiness: string;
}

export interface SubmitBusinessVerificationInput {
  organizationId: string;
  legalBusinessName: string;
  entityType: string;
  /** Raw Tax ID/EIN — passed straight through, never persisted by this application (Section 9). */
  taxId: string;
  formationJurisdiction: string;
  businessAddress: Record<string, unknown>;
  representative: BusinessRepresentativeInput;
}

export interface SubmitBusinessVerificationResult {
  providerReference: string;
}

export type BusinessVerificationResultStatus = "pending" | "verified" | "rejected" | "review_required";

export interface RetrieveBusinessVerificationStatusResult {
  providerReference: string;
  status: BusinessVerificationResultStatus;
  legalNameResult?: string;
  taxIdResult?: string;
  addressResult?: string;
  representativeResult?: string;
  failureCode?: string;
  reviewRequired?: boolean;
}

export interface ParsedBusinessVerificationWebhookEvent {
  provider: string;
  providerEventId: string;
  eventType: string;
  data: Record<string, unknown>;
}

/**
 * Real implementation: a future production adapter (e.g. Middesk/Alloy/Persona Business) selected
 * through getBusinessVerificationProvider.ts. No such adapter exists yet — see that file's own doc
 * comment and providerCapabilities.ts's empty registry entry for `business_verification`.
 */
export interface BusinessVerificationProvider {
  readonly providerName: string;
  readonly providerEnvironment: "production";
  submitVerification(input: SubmitBusinessVerificationInput): Promise<SubmitBusinessVerificationResult>;
  retrieveVerificationStatus(providerReference: string): Promise<RetrieveBusinessVerificationStatusResult>;
  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean;
  parseWebhookEvent(rawBody: string): ParsedBusinessVerificationWebhookEvent;
}
