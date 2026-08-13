import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userAccount } from "@/db/schema";
import type { UserLookupReader } from "./relationshipInvitationService";

export class DrizzleUserLookupReader implements UserLookupReader {
  async findUserIdByEmail(email: string): Promise<string | null> {
    const db = getDb();
    const rows = await db.select({ id: userAccount.id }).from(userAccount).where(eq(userAccount.email, email)).limit(1);
    return rows[0]?.id ?? null;
  }
}
