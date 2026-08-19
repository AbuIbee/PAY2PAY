import "server-only";

export type KycVerificationStatus = "pending" | "approved" | "declined";

/**
 * Government-ID check and selfie/liveness check are folded in as sub-fields of one individual
 * submission (mirrors real KYC providers like Persona/Onfido, which run both checks as part of a
 * single verification session) rather than exposed as separate interface methods. Every field here
 * is an opaque reference/token to material already captured/stored elsewhere (never a raw image) —
 * "never store the raw government-ID image or selfie beyond what the provider integration requires
 * in transit; prefer provider-side storage and a reference/token" per this sprint's text.
 */
export interface SubmitIndividualVerificationInput {
  profileId: string;
  legalName: string;
  dateOfBirth: string;
  governmentIdDocumentRef: string;
  selfieRef: string;
}

/** Bank-account-ownership check folded in the same way, as `bankAccountOwnershipRef`. */
export interface SubmitBusinessVerificationInput {
  profileId: string;
  legalBusinessName: string;
  registrationNumber: string;
  representativeGovernmentIdRef: string;
  bankAccountOwnershipRef: string;
}

export interface SubmitVerificationResult {
  providerVerificationId: string;
}

export interface RetrieveVerificationStatusResult {
  providerVerificationId: string;
  status: KycVerificationStatus;
}

export interface ParsedKycWebhookEvent {
  provider: string;
  providerEventId: string;
  eventType: string;
  data: Record<string, unknown>;
}

/**
 * Sprint 9 KYC/KYB provider abstraction — deliberately separate from src/lib/payments/paymentProvider.ts's
 * PaymentProvider interface (this sprint's own text: "do not merge the two interfaces"), even though
 * both eventually need webhook verification. Wired to Sprint 3's VerificationService state machine
 * by src/lib/kyc/kycVerificationService.ts and kycWebhookService.ts — `isFullyVerified` and its
 * existing callers require no changes.
 */
export interface KycKybProvider {
  readonly providerName: string;
  /** PRSprint 21 — see PaymentProvider.providerEnvironment's identical doc comment. */
  readonly providerEnvironment: "sandbox" | "production";
  submitIndividualVerification(input: SubmitIndividualVerificationInput): Promise<SubmitVerificationResult>;
  submitBusinessVerification(input: SubmitBusinessVerificationInput): Promise<SubmitVerificationResult>;
  retrieveVerificationStatus(providerVerificationId: string): Promise<RetrieveVerificationStatusResult>;
  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean;
  parseWebhookEvent(rawBody: string): ParsedKycWebhookEvent;
}
