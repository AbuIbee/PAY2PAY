import "server-only";
import type { SubscriptionPaymentMethodKind } from "./platformBillingProvider";

export interface SubscriptionPaymentMethodRecord {
  id: string;
  organizationId: string;
  provider: string;
  providerCustomerReference: string;
  providerPaymentMethodReference: string;
  paymentType: SubscriptionPaymentMethodKind;
  displayLast4: string | null;
  displayName: string | null;
  status: "active" | "removed";
  createdAt: Date;
}

/** Real implementation: DrizzleSubscriptionPaymentMethodRepository. DB-8: safe metadata only — never CVV/card PAN/raw bank credentials. */
export interface SubscriptionPaymentMethodRepository {
  insert(input: {
    organizationId: string;
    provider: string;
    providerCustomerReference: string;
    providerPaymentMethodReference: string;
    paymentType: SubscriptionPaymentMethodKind;
    displayLast4: string | null;
    displayName: string | null;
  }): Promise<SubscriptionPaymentMethodRecord>;
  findActiveForOrganization(organizationId: string): Promise<SubscriptionPaymentMethodRecord | null>;
  markRemoved(id: string): Promise<void>;
}
