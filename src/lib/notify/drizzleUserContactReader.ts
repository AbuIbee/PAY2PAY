import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userAccount } from "@/db/schema";
import type { UserContactReader } from "./notificationService";

export class DrizzleUserContactReader implements UserContactReader {
  async getEmail(userId: string): Promise<string | null> {
    const db = getDb();
    const rows = await db.select({ email: userAccount.email }).from(userAccount).where(eq(userAccount.id, userId)).limit(1);
    return rows[0]?.email ?? null;
  }
}
