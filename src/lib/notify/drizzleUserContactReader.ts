import "server-only";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { mfaCredential, userAccount } from "@/db/schema";
import type { UserContactReader } from "./notificationService";

export class DrizzleUserContactReader implements UserContactReader {
  async getEmail(userId: string): Promise<string | null> {
    const db = getDb();
    const rows = await db.select({ email: userAccount.email }).from(userAccount).where(eq(userAccount.id, userId)).limit(1);
    return rows[0]?.email ?? null;
  }

  /**
   * PRSprint 15 (docs/prsprints/PRSPRINT_15_PRODUCTION_SMS.md), requirement #9: `user_account.phone`
   * is never written anywhere in this codebase (confirmed by a full-repo search before this change) —
   * it has been a dead, always-null column since it was introduced, meaning the notification "sms"
   * channel has never actually had a destination to resolve for any user. The one place this codebase
   * *does* have proof a user controls a given phone number is a verified SMS MFA credential
   * (`mfa_credential` where `method = 'sms'` and `verifiedAt` is set) — enrollment requires correctly
   * entering an OTP code sent to that exact number (`MfaService.beginSmsEnrollment`/
   * `confirmSmsEnrollment`), which is meaningfully stronger evidence than an unverified free-text field
   * ever was. This is the best available proxy for "phone verified and eligible for transactional SMS"
   * in the current architecture, not a dedicated SMS-notification-consent flow — that remains a real,
   * documented gap (see PRSprint 15's own completion doc), not silently assumed solved.
   */
  async getPhone(userId: string): Promise<string | null> {
    const db = getDb();
    const rows = await db
      .select({ phoneRef: mfaCredential.phoneRef })
      .from(mfaCredential)
      .where(and(eq(mfaCredential.userId, userId), eq(mfaCredential.method, "sms"), isNotNull(mfaCredential.verifiedAt), isNull(mfaCredential.disabledAt)))
      .orderBy(desc(mfaCredential.verifiedAt))
      .limit(1);
    return rows[0]?.phoneRef ?? null;
  }
}
