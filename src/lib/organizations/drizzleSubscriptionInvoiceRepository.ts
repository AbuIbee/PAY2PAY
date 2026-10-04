import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { subscriptionInvoice } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { SubscriptionInvoiceStatus } from "./platformBillingProvider";
import type { SubscriptionInvoiceRecord, SubscriptionInvoiceRepository } from "./subscriptionInvoiceRepository";

type Row = typeof subscriptionInvoice.$inferSelect;

function toRecord(row: Row): SubscriptionInvoiceRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    subscriptionId: row.subscriptionId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    amountDueMinorUnits: row.amountDueMinorUnits,
    amountPaidMinorUnits: row.amountPaidMinorUnits,
    status: row.status,
    dueAt: row.dueAt,
    paidAt: row.paidAt,
    providerInvoiceReference: row.providerInvoiceReference,
    createdAt: row.createdAt,
  };
}

export class DrizzleSubscriptionInvoiceRepository implements SubscriptionInvoiceRepository {
  async insert(input: {
    organizationId: string;
    subscriptionId: string;
    periodStart: Date;
    periodEnd: Date;
    amountDueMinorUnits: number;
    dueAt: Date;
    providerInvoiceReference: string | null;
  }): Promise<SubscriptionInvoiceRecord> {
    const db = getDb();
    const [row] = await db.insert(subscriptionInvoice).values(input).returning();
    if (!row) throw new ConfigurationError("subscription_invoice insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<SubscriptionInvoiceRecord | null> {
    const db = getDb();
    const rows = await db.select().from(subscriptionInvoice).where(eq(subscriptionInvoice.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async findByProviderInvoiceReference(providerInvoiceReference: string): Promise<SubscriptionInvoiceRecord | null> {
    const db = getDb();
    const rows = await db.select().from(subscriptionInvoice).where(eq(subscriptionInvoice.providerInvoiceReference, providerInvoiceReference)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listForOrganization(organizationId: string): Promise<SubscriptionInvoiceRecord[]> {
    const db = getDb();
    const rows = await db.select().from(subscriptionInvoice).where(eq(subscriptionInvoice.organizationId, organizationId));
    return rows.map(toRecord);
  }

  async markPaid(id: string, input: { amountPaidMinorUnits: number; paidAt: Date }): Promise<void> {
    const db = getDb();
    await db.update(subscriptionInvoice).set({ ...input, status: "paid" }).where(eq(subscriptionInvoice.id, id));
  }

  async markStatus(id: string, status: SubscriptionInvoiceStatus): Promise<void> {
    const db = getDb();
    await db.update(subscriptionInvoice).set({ status }).where(eq(subscriptionInvoice.id, id));
  }
}
