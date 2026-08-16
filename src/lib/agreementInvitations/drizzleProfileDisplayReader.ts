import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessProfile, personalProfile } from "@/db/schema";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import type { ProfileDisplayReader } from "./agreementInvitationService";

/**
 * PRSprint 10: safe-for-anonymous-disclosure display info only — never email, never userId, never
 * verification/KYC state, never any other private profile field. Backs the anonymous review page's
 * "sender display name" / "sender business name where applicable" requirement, and this PRSprint's
 * own "Anonymous Information Restrictions" list (no private profile data, no internal IDs).
 */
export class DrizzleProfileDisplayReader implements ProfileDisplayReader {
  async getDisplayName(profileKind: ProfileKind, profileId: string): Promise<{ displayName: string; businessName: string | null }> {
    const db = getDb();
    if (profileKind === "business") {
      const rows = await db
        .select({ displayName: businessProfile.displayName })
        .from(businessProfile)
        .where(eq(businessProfile.id, profileId))
        .limit(1);
      const name = rows[0]?.displayName ?? "A Paid2You business";
      return { displayName: name, businessName: name };
    }
    const rows = await db
      .select({ legalName: personalProfile.legalName })
      .from(personalProfile)
      .where(eq(personalProfile.id, profileId))
      .limit(1);
    return { displayName: rows[0]?.legalName ?? "A Paid2You member", businessName: null };
  }
}
