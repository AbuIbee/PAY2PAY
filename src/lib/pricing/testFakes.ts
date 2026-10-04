import { randomUUID } from "node:crypto";
import type { PricingPlanEntitlementRecord, PricingPlanEntitlementRepository } from "./pricingPlanEntitlementRepository";
import { PricingService } from "./pricingService";
import type {
  PricingPlanKind,
  PricingPlanRecord,
  PricingPlanRepository,
  ProfileKind,
  SubscriptionRecord,
  SubscriptionRepository,
} from "./pricingService";

export class InMemoryPricingPlanRepository implements PricingPlanRepository {
  private byId = new Map<string, PricingPlanRecord>();

  seed(input: Partial<PricingPlanRecord> & { kind: PricingPlanKind; code: string; name: string }): PricingPlanRecord {
    const record: PricingPlanRecord = {
      id: randomUUID(),
      monthlyFeeMinorUnits: null,
      annualFeeMinorUnits: null,
      perAgreementFeeMinorUnits: null,
      perSuccessfulPaymentFeeMinorUnits: null,
      freeAgreementAllowance: null,
      freeIncludedPaymentsAllowance: null,
      isActive: true,
      effectiveAt: new Date(),
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async insert(input: {
    kind: PricingPlanKind;
    code: string;
    name: string;
    monthlyFeeMinorUnits: number | null;
    annualFeeMinorUnits: number | null;
    perAgreementFeeMinorUnits: number | null;
    perSuccessfulPaymentFeeMinorUnits: number | null;
    freeAgreementAllowance: number | null;
    freeIncludedPaymentsAllowance: number | null;
    isActive: boolean;
  }): Promise<PricingPlanRecord> {
    return this.seed(input);
  }

  async findById(id: string): Promise<PricingPlanRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findByCode(code: string): Promise<PricingPlanRecord | null> {
    return [...this.byId.values()].find((p) => p.code === code) ?? null;
  }

  /** Mirrors DrizzlePricingPlanRepository's ascending-price ordering. */
  async listActiveByKind(kind: PricingPlanKind): Promise<PricingPlanRecord[]> {
    return [...this.byId.values()]
      .filter((p) => p.kind === kind && p.isActive)
      .sort((a, b) => (a.monthlyFeeMinorUnits ?? Infinity) - (b.monthlyFeeMinorUnits ?? Infinity));
  }
}

export class InMemorySubscriptionRepository implements SubscriptionRepository {
  private byId = new Map<string, SubscriptionRecord>();

  async insert(input: {
    profileKind: ProfileKind;
    profileId: string;
    pricingPlanId: string;
  }): Promise<SubscriptionRecord> {
    const record: SubscriptionRecord = {
      id: randomUUID(),
      status: "active",
      startedAt: new Date(),
      endedAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      providerCustomerReference: null,
      providerSubscriptionReference: null,
      negotiatedMonthlyFeeMinorUnits: null,
      negotiatedNewArrangementsMonthlyLimit: null,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<SubscriptionRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findActiveByProfile(profileKind: ProfileKind, profileId: string): Promise<SubscriptionRecord | null> {
    return (
      [...this.byId.values()].find(
        (s) => s.profileKind === profileKind && s.profileId === profileId && s.status === "active",
      ) ?? null
    );
  }

  async findByProviderSubscriptionReference(providerSubscriptionReference: string): Promise<SubscriptionRecord | null> {
    return [...this.byId.values()].find((s) => s.providerSubscriptionReference === providerSubscriptionReference) ?? null;
  }

  async findByProviderCustomerReference(providerCustomerReference: string): Promise<SubscriptionRecord | null> {
    return [...this.byId.values()].find((s) => s.providerCustomerReference === providerCustomerReference) ?? null;
  }

  async cancel(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) {
      record.status = "canceled";
      record.endedAt = new Date();
    }
  }

  async setProviderReferences(id: string, input: { providerCustomerReference: string | null; providerSubscriptionReference: string | null }): Promise<void> {
    const record = this.byId.get(id);
    if (record) Object.assign(record, input);
  }

  async setBillingPeriod(id: string, input: { currentPeriodStart: Date; currentPeriodEnd: Date }): Promise<void> {
    const record = this.byId.get(id);
    if (record) Object.assign(record, input);
  }

  async requestCancelAtPeriodEnd(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) {
      record.cancelAtPeriodEnd = true;
      record.canceledAt = new Date();
    }
  }

  async reactivate(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) {
      record.cancelAtPeriodEnd = false;
      record.canceledAt = null;
    }
  }

  async setNegotiatedTerms(
    id: string,
    input: { negotiatedMonthlyFeeMinorUnits: number | null; negotiatedNewArrangementsMonthlyLimit: number | null },
  ): Promise<void> {
    const record = this.byId.get(id);
    if (record) Object.assign(record, input);
  }

  async setPricingPlan(id: string, pricingPlanId: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.pricingPlanId = pricingPlanId;
  }
}

export function createTestPricingService() {
  const plans = new InMemoryPricingPlanRepository();
  const subscriptions = new InMemorySubscriptionRepository();
  const pricingService = new PricingService(plans, subscriptions);
  return { pricingService, plans, subscriptions };
}

/** "PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE", Phase 2 (2026-10-02). */
export class InMemoryPricingPlanEntitlementRepository implements PricingPlanEntitlementRepository {
  private byId = new Map<string, PricingPlanEntitlementRecord>();

  seed(input: { pricingPlanId: string; featureKey: string; enabled?: boolean; limitValue?: number | null }): PricingPlanEntitlementRecord {
    const record: PricingPlanEntitlementRecord = {
      id: randomUUID(),
      enabled: true,
      limitValue: null,
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async insert(input: { pricingPlanId: string; featureKey: string; enabled: boolean; limitValue: number | null }): Promise<PricingPlanEntitlementRecord> {
    return this.seed(input);
  }

  async findByPlanAndFeature(pricingPlanId: string, featureKey: string): Promise<PricingPlanEntitlementRecord | null> {
    return [...this.byId.values()].find((r) => r.pricingPlanId === pricingPlanId && r.featureKey === featureKey) ?? null;
  }

  async listByPlan(pricingPlanId: string): Promise<PricingPlanEntitlementRecord[]> {
    return [...this.byId.values()].filter((r) => r.pricingPlanId === pricingPlanId);
  }
}

export function createTestPricingServiceWithEntitlements() {
  const { pricingService, plans, subscriptions } = createTestPricingService();
  const entitlements = new InMemoryPricingPlanEntitlementRepository();
  return { pricingService, plans, subscriptions, entitlements };
}
