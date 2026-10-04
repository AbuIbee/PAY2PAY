import "server-only";
import type { SubscriptionInvoiceStatus } from "./platformBillingProvider";

export interface SubscriptionInvoiceRecord {
  id: string;
  organizationId: string;
  subscriptionId: string;
  periodStart: Date;
  periodEnd: Date;
  amountDueMinorUnits: number;
  amountPaidMinorUnits: number;
  status: SubscriptionInvoiceStatus;
  dueAt: Date;
  paidAt: Date | null;
  providerInvoiceReference: string | null;
  createdAt: Date;
}

/** Real implementation: DrizzleSubscriptionInvoiceRepository. */
export interface SubscriptionInvoiceRepository {
  insert(input: {
    organizationId: string;
    subscriptionId: string;
    periodStart: Date;
    periodEnd: Date;
    amountDueMinorUnits: number;
    dueAt: Date;
    providerInvoiceReference: string | null;
  }): Promise<SubscriptionInvoiceRecord>;
  findById(id: string): Promise<SubscriptionInvoiceRecord | null>;
  findByProviderInvoiceReference(providerInvoiceReference: string): Promise<SubscriptionInvoiceRecord | null>;
  /** Tenant-scoped by construction — never another organization's invoices (DB-18/cross-tenant). */
  listForOrganization(organizationId: string): Promise<SubscriptionInvoiceRecord[]>;
  markPaid(id: string, input: { amountPaidMinorUnits: number; paidAt: Date }): Promise<void>;
  markStatus(id: string, status: SubscriptionInvoiceStatus): Promise<void>;
}
