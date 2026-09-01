import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userAccount } from "@/db/schema";
import type { UserAuthEmailReader } from "./personalProfileService";

/** Decision 6: read-only view of the auth email and whether it's verified — never touches it. */
export class DrizzleUserAuthEmailReader implements UserAuthEmailReader {
  async getVerifiedEmail(userId: string): Promise<string | null> {
    const db = getDb();
    const rows = await db
      .select({ email: userAccount.email, emailVerifiedAt: userAccount.emailVerifiedAt })
      .from(userAccount)
      .where(eq(userAccount.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row || !row.emailVerifiedAt) return null;
    return row.email;
  }
}
