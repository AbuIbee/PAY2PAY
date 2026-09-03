import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { personalProfile } from "@/db/schema";
import type { PreferredEmailSyncTarget } from "./authService";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Real implementation of PreferredEmailSyncTarget — see that interface's own doc comment in authService.ts. */
export class DrizzlePreferredEmailSyncTarget implements PreferredEmailSyncTarget {
  async syncVerifiedAuthEmail(userId: string, verifiedEmail: string): Promise<void> {
    const db = getDb();
    const normalized = normalizeEmail(verifiedEmail);
    await db
      .update(personalProfile)
      .set({ preferredEmailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(personalProfile.userId, userId),
          eq(personalProfile.preferredEmail, normalized),
          isNull(personalProfile.preferredEmailVerifiedAt),
        ),
      );
  }
}
