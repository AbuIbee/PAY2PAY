import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { personalProfile } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { PersonalProfileRecord, PersonalProfileRepository } from "./authService";

export class DrizzlePersonalProfileRepository implements PersonalProfileRepository {
  async insert(userId: string): Promise<PersonalProfileRecord> {
    const db = getDb();
    const [row] = await db.insert(personalProfile).values({ userId }).returning();
    if (!row) {
      throw new ConfigurationError("personal_profile insert returned no row");
    }
    return { id: row.id, userId: row.userId };
  }

  async findByUserId(userId: string): Promise<PersonalProfileRecord | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(personalProfile)
      .where(eq(personalProfile.userId, userId))
      .limit(1);
    const row = rows[0];
    return row ? { id: row.id, userId: row.userId } : null;
  }
}
