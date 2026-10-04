import "server-only";
import { randomUUID } from "node:crypto";
import { ValidationError } from "@/lib/errors";
import type {
  BusinessVerificationProvider,
  BusinessVerificationResultStatus,
  ParsedBusinessVerificationWebhookEvent,
  RetrieveBusinessVerificationStatusResult,
  SubmitBusinessVerificationInput,
  SubmitBusinessVerificationResult,
} from "@/lib/organizations/businessVerificationProvider";
import { computeHmacSignature, verifyHmacSignature } from "@/lib/webhookSignature";

/**
 * Test-double only (mirrors src/test-support/kyc/sandboxKycProvider.ts's own "relocated out of the
 * production tree so no production route/factory can import it" precedent — never imported by
 * getBusinessVerificationProvider.ts or providerCapabilities.ts). Every submission starts "pending"
 * and only transitions via `simulateDecision` or a signed webhook payload — never auto-approved on
 * submission, matching Section 9's "no fabricated verification" requirement even in this fake.
 */
export class SandboxBusinessVerificationProvider implements BusinessVerificationProvider {
  readonly providerName = "sandbox_business_verification_mock";
  readonly providerEnvironment = "production" as const;
  private readonly statuses = new Map<string, BusinessVerificationResultStatus>();

  constructor(private readonly webhookSecret: string) {}

  async submitVerification(_input: SubmitBusinessVerificationInput): Promise<SubmitBusinessVerificationResult> {
    const providerReference = `sandbox_bizver_${randomUUID()}`;
    this.statuses.set(providerReference, "pending");
    return { providerReference };
  }

  async retrieveVerificationStatus(providerReference: string): Promise<RetrieveBusinessVerificationStatusResult> {
    const status = this.statuses.get(providerReference);
    if (!status) throw new ValidationError("Unknown business verification reference.");
    return { providerReference, status };
  }

  /** Test/sandbox-simulator helper — mirrors a real provider's async decision. */
  simulateDecision(providerReference: string, status: BusinessVerificationResultStatus): void {
    if (this.statuses.has(providerReference)) this.statuses.set(providerReference, status);
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    return verifyHmacSignature(rawBody, signatureHeader, this.webhookSecret);
  }

  parseWebhookEvent(rawBody: string): ParsedBusinessVerificationWebhookEvent {
    let parsed: { providerEventId?: unknown; eventType?: unknown; [key: string]: unknown };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      throw new ValidationError("Webhook payload is not valid JSON.");
    }
    if (typeof parsed.providerEventId !== "string" || typeof parsed.eventType !== "string") {
      throw new ValidationError("Webhook payload is missing providerEventId/eventType.");
    }
    return { provider: this.providerName, providerEventId: parsed.providerEventId, eventType: parsed.eventType, data: parsed };
  }

  /** Test/sandbox-simulator helper — produces a signature a real caller would send in the webhook's signature header. */
  signWebhookPayload(rawBody: string): string {
    return computeHmacSignature(rawBody, this.webhookSecret);
  }
}
