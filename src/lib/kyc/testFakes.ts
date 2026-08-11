import { randomUUID } from "node:crypto";
import { createTestVerificationService } from "@/lib/profiles/testFakes";
import { KycVerificationService } from "./kycVerificationService";
import { KycWebhookService } from "./kycWebhookService";
import type { KycWebhookEventRecord, KycWebhookEventRepository } from "./kycWebhookService";
import { SandboxKycProvider } from "./sandboxKycProvider";

/** Test-only in-memory doubles for the KYC/KYB services, mirroring src/lib/payments/testFakes.ts's pattern. */

export class InMemoryKycWebhookEventRepository implements KycWebhookEventRepository {
  private byId = new Map<string, KycWebhookEventRecord>();

  async findByProviderEvent(provider: string, providerEventId: string): Promise<KycWebhookEventRecord | null> {
    return [...this.byId.values()].find((e) => e.provider === provider && e.providerEventId === providerEventId) ?? null;
  }

  async insert(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    signatureVerified: boolean;
    payload: unknown;
  }): Promise<KycWebhookEventRecord> {
    const existing = await this.findByProviderEvent(input.provider, input.providerEventId);
    if (existing) throw new Error("duplicate webhook event");
    const record: KycWebhookEventRecord = { id: randomUUID(), receivedAt: new Date(), processedAt: null, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async markProcessed(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.processedAt = new Date();
  }
}

const TEST_KYC_WEBHOOK_SECRET = "test-sandbox-kyc-webhook-secret";

/** Builds a full KYC/KYB test context: submission service, webhook service, and the shared VerificationService/provider instances underneath both, exactly as production does. */
export function createTestKycServices() {
  const verificationCtx = createTestVerificationService();
  const provider = new SandboxKycProvider(TEST_KYC_WEBHOOK_SECRET);
  const events = new InMemoryKycWebhookEventRepository();

  const kycVerificationService = new KycVerificationService({
    provider,
    verification: verificationCtx.verificationService,
  });
  const kycWebhookService = new KycWebhookService({
    provider,
    events,
    verification: verificationCtx.verificationService,
  });

  return { verificationCtx, provider, events, kycVerificationService, kycWebhookService };
}
