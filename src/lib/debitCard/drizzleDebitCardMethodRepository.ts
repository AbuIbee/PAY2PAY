import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { debitCardMethod } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { DebitCardMethodRecord, DebitCardMethodRepository } from "./debitCardMethodService";

type Row = typeof debitCardMethod.$inferSelect;

function toRecord(row: Row): DebitCardMethodRecord {
  return {
    id: row.id,
    agreementId: row.agreementId,
    payerProfileKind: row.payerProfileKind,
    payerProfileId: row.payerProfileId,
    cardToken: row.cardToken,
    cardLast4: row.cardLast4,
    cardBrand: row.cardBrand,
    expiresAtMonth: row.expiresAtMonth,
    expiresAtYear: row.expiresAtYear,
    status: row.status,
    registeredAt: row.registeredAt,
    replacedAt: row.replacedAt,
    replacedReason: row.replacedReason,
    supersedesCardMethodId: row.supersedesCardMethodId,
    createdAt: row.createdAt,
  };
}

export class DrizzleDebitCardMethodRepository implements DebitCardMethodRepository {
  async insert(input: {
    agreementId: string;
    payerProfileKind: "personal" | "business";
    payerProfileId: string;
    cardToken: string;
    cardLast4: string;
    cardBrand: string | null;
    expiresAtMonth: number;
    expiresAtYear: number;
    supersedesCardMethodId: string | null;
  }): Promise<DebitCardMethodRecord> {
    const db = getDb();
    const [row] = await db.insert(debitCardMethod).values(input).returning();
    if (!row) throw new ConfigurationError("debit_card_method insert returned no row");
    return toRecord(row);
  }

  async findActiveForAgreement(agreementId: string): Promise<DebitCardMethodRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(debitCardMethod)
      .where(and(eq(debitCardMethod.agreementId, agreementId), eq(debitCardMethod.status, "active")))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<DebitCardMethodRecord | null> {
    const db = getDb();
    const rows = await db.select().from(debitCardMethod).where(eq(debitCardMethod.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markReplaced(id: string, replacedAt: Date, replacedReason: string): Promise<DebitCardMethodRecord> {
    const db = getDb();
    const [row] = await db
      .update(debitCardMethod)
      .set({ status: "replaced", replacedAt, replacedReason })
      .where(eq(debitCardMethod.id, id))
      .returning();
    if (!row) throw new ConfigurationError("debit_card_method markReplaced found no row");
    return toRecord(row);
  }
}
