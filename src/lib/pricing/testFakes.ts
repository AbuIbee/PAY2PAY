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

  async findById(id: string): Promise<PricingPlanRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findByCode(code: string): Promise<PricingPlanRecord | null> {
    return [...this.byId.values()].find((p) => p.code === code) ?? null;
  }

  async listActiveByKind(kind: PricingPlanKind): Promise<PricingPlanRecord[]> {
    return [...this.byId.values()].filter((p) => p.kind === kind && p.isActive);
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
      ...input,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findActiveByProfile(profileKind: ProfileKind, profileId: string): Promise<SubscriptionRecord | null> {
    return (
      [...this.byId.values()].find(
        (s) => s.profileKind === profileKind && s.profileId === profileId && s.status === "active",
      ) ?? null
    );
  }

  async cancel(id: string): Promise<void> {
    const record = this.byId.get(id);
    if (record) {
      record.status = "canceled";
      record.endedAt = new Date();
    }
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
