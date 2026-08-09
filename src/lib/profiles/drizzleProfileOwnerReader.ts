import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { businessProfile, personalProfile } from "@/db/schema";
import type { ProfileKind, ProfileOwnerReader } from "./verificationService";

export class DrizzleProfileOwnerReader implements ProfileOwnerReader {
  async getOwnerUserId(profileKind: ProfileKind, profileId: string): Promise<string | null> {
    const db = getDb();
    if (profileKind === "personal") {
      const rows = await db
        .select({ userId: personalProfile.userId })
        .from(personalProfile)
        .where(eq(personalProfile.id, profileId))
        .limit(1);
      return rows[0]?.userId ?? null;
    }
    const rows = await db
      .select({ ownerUserId: businessProfile.ownerUserId })
      .from(businessProfile)
      .where(eq(businessProfile.id, profileId))
      .limit(1);
    return rows[0]?.ownerUserId ?? null;
  }
}
