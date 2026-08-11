import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { personalProfile, userAccount } from "@/db/schema";
import type { CustomerAccountResolver } from "./csvImportService";

export class DrizzleCustomerAccountResolver implements CustomerAccountResolver {
  async resolvePersonalProfileByEmail(email: string): Promise<string | null> {
    const db = getDb();
    const userRows = await db.select({ id: userAccount.id }).from(userAccount).where(eq(userAccount.email, email)).limit(1);
    const user = userRows[0];
    if (!user) return null;
    const profileRows = await db
      .select({ id: personalProfile.id })
      .from(personalProfile)
      .where(eq(personalProfile.userId, user.id))
      .limit(1);
    return profileRows[0]?.id ?? null;
  }
}
