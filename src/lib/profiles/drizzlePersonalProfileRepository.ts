import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { personalProfile } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { PersonalAddress, PersonalProfileRecord, PersonalProfileRepository } from "./personalProfileService";

type Row = typeof personalProfile.$inferSelect;

function toRecord(row: Row): PersonalProfileRecord {
  return {
    id: row.id,
    userId: row.userId,
    legalName: row.legalName,
    firstName: row.firstName,
    lastName: row.lastName,
    preferredEmail: row.preferredEmail,
    preferredEmailVerifiedAt: row.preferredEmailVerifiedAt,
    contactPhone: row.contactPhone,
    residentialAddress: (row.residentialAddress as PersonalAddress | null) ?? null,
    currency: row.currency,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzlePersonalProfileRepository implements PersonalProfileRepository {
  async findByUserId(userId: string): Promise<PersonalProfileRecord | null> {
    const db = getDb();
    const rows = await db.select().from(personalProfile).where(eq(personalProfile.userId, userId)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<PersonalProfileRecord | null> {
    const db = getDb();
    const rows = await db.select().from(personalProfile).where(eq(personalProfile.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async update(
    id: string,
    input: {
      firstName: string;
      lastName: string;
      preferredEmail: string;
      preferredEmailVerifiedAt: Date | null;
      contactPhone: string;
      residentialAddress: PersonalAddress;
    },
  ): Promise<PersonalProfileRecord> {
    const db = getDb();
    const [row] = await db
      .update(personalProfile)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(personalProfile.id, id))
      .returning();
    if (!row) throw new ConfigurationError("personal_profile update found no row");
    return toRecord(row);
  }
}
