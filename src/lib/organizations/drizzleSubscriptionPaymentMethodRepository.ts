import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { subscriptionPaymentMethod } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { SubscriptionPaymentMethodRecord, SubscriptionPaymentMethodRepository } from "./subscriptionPaymentMethodRepository";

type Row = typeof subscriptionPaymentMethod.$inferSelect;

function toRecord(row: Row): SubscriptionPaymentMethodRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    providerCustomerReference: row.providerCustomerReference,
    providerPaymentMethodReference: row.providerPaymentMethodReference,
    paymentType: row.paymentType,
    displayLast4: row.displayLast4,
    displayName: row.displayName,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export class DrizzleSubscriptionPaymentMethodRepository implements SubscriptionPaymentMethodRepository {
  async insert(input: {
    organizationId: string;
    provider: string;
    providerCustomerReference: string;
    providerPaymentMethodReference: string;
    paymentType: "card" | "bank_account" | "other";
    displayLast4: string | null;
    displayName: string | null;
  }): Promise<SubscriptionPaymentMethodRecord> {
    const db = getDb();
    const [row] = await db.insert(subscriptionPaymentMethod).values(input).returning();
    if (!row) throw new ConfigurationError("subscription_payment_method insert returned no row");
    return toRecord(row);
  }

  async findActiveForOrganization(organizationId: string): Promise<SubscriptionPaymentMethodRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(subscriptionPaymentMethod)
      .where(and(eq(subscriptionPaymentMethod.organizationId, organizationId), eq(subscriptionPaymentMethod.status, "active")))
      .orderBy(desc(subscriptionPaymentMethod.createdAt))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async markRemoved(id: string): Promise<void> {
    const db = getDb();
    await db.update(subscriptionPaymentMethod).set({ status: "removed" }).where(eq(subscriptionPaymentMethod.id, id));
  }
}
