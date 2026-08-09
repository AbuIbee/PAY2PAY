import { randomUUID } from "node:crypto";
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
