import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { smsOptOut } from "@/db/schema";
import type { SmsOptOutRepository } from "./notificationService";

export class DrizzleSmsOptOutRepository implements SmsOptOutRepository {
  async isOptedOut(phone: string): Promise<boolean> {
    const db = getDb();
    const rows = await db.select({ phone: smsOptOut.phone }).from(smsOptOut).where(eq(smsOptOut.phone, phone)).limit(1);
    return rows.length > 0;
  }

  async recordOptOut(phone: string, source: "stop_keyword" | "provider_rejection"): Promise<void> {
    const db = getDb();
    // Idempotent by construction — a repeated STOP reply (or a provider rejection for an
    // already-recorded number) is a no-op update, never a duplicate row or an error.
    await db
      .insert(smsOptOut)
      .values({ phone, source })
      .onConflictDoUpdate({ target: smsOptOut.phone, set: { source, optedOutAt: sql`now()` } });
  }
}
