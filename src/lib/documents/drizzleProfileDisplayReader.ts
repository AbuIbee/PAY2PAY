import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessProfile, personalProfile } from "@/db/schema";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import type { ProfileDisplayReader } from "./profileDisplayReader";

export class DrizzleProfileDisplayReader implements ProfileDisplayReader {
  async getDisplayName(profileKind: ProfileKind, profileId: string): Promise<string> {
    const db = getDb();
    if (profileKind === "personal") {
      const rows = await db
        .select({ legalName: personalProfile.legalName })
        .from(personalProfile)
        .where(eq(personalProfile.id, profileId))
        .limit(1);
      return rows[0]?.legalName ?? "Personal profile";
    }
    const rows = await db
      .select({ displayName: businessProfile.displayName, legalBusinessName: businessProfile.legalBusinessName })
      .from(businessProfile)
      .where(eq(businessProfile.id, profileId))
      .limit(1);
    const row = rows[0];
    return row?.displayName ?? row?.legalBusinessName ?? "Business profile";
  }
}
