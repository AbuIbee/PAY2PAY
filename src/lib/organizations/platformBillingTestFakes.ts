import "server-only";
import { randomUUID } from "node:crypto";
import type { SubscriptionInvoiceStatus } from "./platformBillingProvider";
import type { PlatformBillingWebhookEventRecord, PlatformBillingWebhookEventRepository } from "./platformBillingWebhookEventRepository";
import type { SubscriptionInvoiceRecord, SubscriptionInvoiceRepository } from "./subscriptionInvoiceRepository";
import type { SubscriptionPaymentMethodRecord, SubscriptionPaymentMethodRepository } from "./subscriptionPaymentMethodRepository";

export class InMemorySubscriptionInvoiceRepository implements SubscriptionInvoiceRepository {
  private byId = new Map<string, SubscriptionInvoiceRecord>();

  async insert(input: {
    organizationId: string;
    subscriptionId: string;
    periodStart: Date;
    periodEnd: Date;
    amountDueMinorUnits: number;
    dueAt: Date;
    providerInvoiceReference: string | null;
  }): Promise<SubscriptionInvoiceRecord> {
    const record: SubscriptionInvoiceRecord = {
      id: randomUUID(),
      amountPaidMinorUnits: 0,
      status: "open",
      paidAt: null,
      createdAt: new Date(),
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<SubscriptionInvoiceRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findByProviderInvoiceReference(providerInvoiceReference: string): Promise<SubscriptionInvoiceRecord | null> {
    return [...this.byId.values()].find((r) => r.providerInvoiceReference === providerInvoiceReference) ?? null;
  }

  async listForOrganization(organizationId: string): Promise<SubscriptionInvoiceRecord[]> {
    return [...this.byId.values()].filter((r) => r.organizationId === organizationId);
  }

  async markPaid(id: string, input: { amountPaidMinorUnits: number; paidAt: Date }): Promise<void> {
    const record = this.byId.get(id);
    if (record) Object.assign(record, input, { status: "paid" as SubscriptionInvoiceStatus });
  }

  async markStatus(id: string, status: SubscriptionInvoiceStatus): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.status = status;
  }
}

export class InMemorySubscriptionPaymentMethodRepository implements SubscriptionPaymentMethodRepository {
  private byId = new Map<string, SubscriptionPaymentMethodRecord>();

  async insert(input: {
    organizationId: string;
    provider: string;
    providerCustomerReference: string;
    providerPaymentMethodReference: string;
    paymentType: "card" | "bank_account" | "other";
    displayLast4: string | null;
    displayName: string | null;
  }): Promise<SubscriptionPaymentMethodRecord> {
    const record: SubscriptionPaymentMethodRecord = { id: randomUUID(), status: "active", createdAt: new Date(), ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async findActiveForOrganization(organizationId: string): Promise<SubscriptionPaymentMethodRecord | null> {
    return [...this.byId.values()].find((r) => r.organizationId === organizationId && r.status === "active") ?? null;
  }

  async markRemoved(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.status = "removed";
  }
}

/**
 * "PAID2YOU — FINAL SINGLE P0 DEFECT REMEDIATION" (2026-10-04), P0-5: exported here (mirrors
 * `platformBillingWebhookService.test.ts`'s own identical-shape private fake exactly — that file is
 * frozen/untouched by this remediation) so `businessOnboardingService.test.ts` can exercise the real,
 * already-verified `PlatformBillingWebhookService` to prove the ONE canonical completion path still
 * activates a legacy-`setUpBilling`-originated subscription once the provider genuinely confirms
 * "active" — without duplicating any webhook/claim logic.
 */
export class InMemoryPlatformBillingWebhookEventRepository implements PlatformBillingWebhookEventRepository {
  private byKey = new Map<string, PlatformBillingWebhookEventRecord & { claimedAt: Date | null }>();

  async claimEvent(input: { provider: string; providerEventId: string; eventType: string; signatureVerified: boolean; payload: unknown; staleClaimMs: number }): Promise<PlatformBillingWebhookEventRecord | null> {
    const key = `${input.provider}:${input.providerEventId}`;
    const now = new Date();
    const existing = this.byKey.get(key);
    if (existing) {
      const claimIsFresh = existing.claimedAt && now.getTime() - existing.claimedAt.getTime() < input.staleClaimMs;
      if (existing.processedAt || claimIsFresh) return null;
      existing.claimedAt = now;
      return existing;
    }
    const record = { id: randomUUID(), provider: input.provider, providerEventId: input.providerEventId, eventType: input.eventType, signatureVerified: input.signatureVerified, payload: input.payload, receivedAt: now, processedAt: null, claimedAt: now };
    this.byKey.set(key, record);
    return record;
  }

  async markProcessed(id: string): Promise<void> {
    for (const record of this.byKey.values()) {
      if (record.id === id) record.processedAt = new Date();
    }
  }
}
