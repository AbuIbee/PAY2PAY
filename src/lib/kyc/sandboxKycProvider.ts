import "server-only";
import { randomUUID } from "node:crypto";
import { ValidationError } from "@/lib/errors";
import { computeHmacSignature, verifyHmacSignature } from "@/lib/webhookSignature";
import type {
  KycKybProvider,
  KycVerificationStatus,
  ParsedKycWebhookEvent,
  RetrieveVerificationStatusResult,
  SubmitBusinessVerificationInput,
  SubmitIndividualVerificationInput,
  SubmitVerificationResult,
} from "./kycProvider";

/**
 * Sprint 9's sandbox/mock KYC/KYB provider — NOT a real Persona/Onfido/Stripe-Identity sandbox
 * integration (this environment has no live provider credentials). Every submission starts
 * "pending" and only transitions via `simulateDecision` (mirroring a real provider's async webhook
 * callback) or a direct webhook payload — never auto-approved on submission. "No UI may claim that
 * sandbox verification is a real identity check" applies to every caller of this class.
 */
export class SandboxKycProvider implements KycKybProvider {
  readonly providerName = "sandbox_kyc_mock";
  readonly providerEnvironment = "sandbox" as const;
  private readonly verifications = new Map<string, KycVerificationStatus>();

  constructor(private readonly webhookSecret: string) {}

  async submitIndividualVerification(_input: SubmitIndividualVerificationInput): Promise<SubmitVerificationResult> {
    return this.startVerification();
  }

  async submitBusinessVerification(_input: SubmitBusinessVerificationInput): Promise<SubmitVerificationResult> {
    return this.startVerification();
  }

  async retrieveVerificationStatus(providerVerificationId: string): Promise<RetrieveVerificationStatusResult> {
    const status = this.verifications.get(providerVerificationId);
    if (!status) throw new ValidationError("Unknown verification reference.");
    return { providerVerificationId, status };
  }

  /** Test/sandbox-simulator helper — mirrors a real provider's async decision (mostly used indirectly, via a signed webhook payload). */
  simulateDecision(providerVerificationId: string, status: KycVerificationStatus): void {
    if (this.verifications.has(providerVerificationId)) this.verifications.set(providerVerificationId, status);
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    return verifyHmacSignature(rawBody, signatureHeader, this.webhookSecret);
  }

  parseWebhookEvent(rawBody: string): ParsedKycWebhookEvent {
    let parsed: { providerEventId?: unknown; eventType?: unknown; [key: string]: unknown };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      throw new ValidationError("Webhook payload is not valid JSON.");
    }
    if (typeof parsed.providerEventId !== "string" || typeof parsed.eventType !== "string") {
      throw new ValidationError("Webhook payload is missing providerEventId/eventType.");
    }
    return {
      provider: this.providerName,
      providerEventId: parsed.providerEventId,
      eventType: parsed.eventType,
      data: parsed,
    };
  }

  /** Test/sandbox-simulator helper — produces a signature a real caller would send in the webhook's signature header. */
  signWebhookPayload(rawBody: string): string {
    return computeHmacSignature(rawBody, this.webhookSecret);
  }

  private startVerification(): SubmitVerificationResult {
    const providerVerificationId = `sandbox_kyc_${randomUUID()}`;
    this.verifications.set(providerVerificationId, "pending");
    return { providerVerificationId };
  }
}
