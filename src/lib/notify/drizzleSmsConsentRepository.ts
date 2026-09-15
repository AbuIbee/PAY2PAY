import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { smsConsent } from "@/db/schema";
import type { SmsConsentRecord, SmsConsentRepository } from "./notificationService";

type Row = typeof smsConsent.$inferSelect;

function toRecord(row: Row): SmsConsentRecord {
  return {
    userId: row.userId,
    active: row.active,
    consentedPhoneE164: row.consentedPhoneE164,
    consentedAt: row.consentedAt,
    withdrawnAt: row.withdrawnAt,
    source: row.source,
    disclosureVersion: row.disclosureVersion,
  };
}

export class DrizzleSmsConsentRepository implements SmsConsentRepository {
  async find(userId: string): Promise<SmsConsentRecord | null> {
    const db = getDb();
    const rows = await db.select().from(smsConsent).where(eq(smsConsent.userId, userId)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async activate(userId: string, input: { source: string; disclosureVersion: string; consentedPhoneE164: string; at: Date }): Promise<SmsConsentRecord> {
    const db = getDb();
    const [row] = await db
      .insert(smsConsent)
      .values({
        userId,
        active: true,
        consentedPhoneE164: input.consentedPhoneE164,
        consentedAt: input.at,
        withdrawnAt: null,
        source: input.source,
        disclosureVersion: input.disclosureVersion,
        updatedAt: input.at,
      })
      .onConflictDoUpdate({
        target: smsConsent.userId,
        set: {
          active: true,
          consentedPhoneE164: input.consentedPhoneE164,
          consentedAt: input.at,
          withdrawnAt: null,
          source: input.source,
          disclosureVersion: input.disclosureVersion,
          updatedAt: input.at,
        },
      })
      .returning();
    return toRecord(row!);
  }

  async withdraw(userId: string, at: Date): Promise<SmsConsentRecord> {
    const db = getDb();
    const [row] = await db
      .insert(smsConsent)
      // Deliberately no `consentedPhoneE164` in the insert branch's values — a brand-new row being
      // withdrawn (one that was never active) has nothing to preserve; `onConflictDoUpdate`'s `set`
      // below correctly omits the column too, so an existing row's own `consentedPhoneE164` is left
      // untouched (never cleared) on withdrawal, matching the schema's own documented "preserved as
      // historical evidence" contract.
      .values({ userId, active: false, withdrawnAt: at, updatedAt: at })
      .onConflictDoUpdate({
        target: smsConsent.userId,
        set: { active: false, withdrawnAt: at, updatedAt: at },
      })
      .returning();
    return toRecord(row!);
  }
}
