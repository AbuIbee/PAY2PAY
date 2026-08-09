import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userAccount } from "@/db/schema";
import type { EmailVerificationReader } from "./verificationService";

export class DrizzleEmailVerificationReader implements EmailVerificationReader {
  async isEmailVerified(userId: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .select({ emailVerifiedAt: userAccount.emailVerifiedAt })
      .from(userAccount)
      .where(eq(userAccount.id, userId))
      .limit(1);
    return rows[0]?.emailVerifiedAt != null;
  }
}
