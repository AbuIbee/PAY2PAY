import "server-only";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userAccount, personalProfile } from "@/db/schema";
import type { StaffDisplayInfo, StaffDisplayReader } from "./staffDisplayReader";

export class DrizzleStaffDisplayReader implements StaffDisplayReader {
  async loadDisplayInfo(userIds: string[]): Promise<Map<string, StaffDisplayInfo>> {
    const result = new Map<string, StaffDisplayInfo>();
    if (userIds.length === 0) return result;
    const db = getDb();
    const rows = await db
      .select({ userId: userAccount.id, email: userAccount.email, legalName: personalProfile.legalName })
      .from(userAccount)
      .leftJoin(personalProfile, eq(personalProfile.userId, userAccount.id))
      .where(inArray(userAccount.id, userIds));
    for (const row of rows) {
      result.set(row.userId, { name: row.legalName, email: row.email });
    }
    return result;
  }
}
