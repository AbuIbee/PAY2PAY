import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { preferredEmailVerificationToken } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type { PreferredEmailVerificationRepository } from "./personalProfileService";

export class DrizzlePreferredEmailVerificationRepository implements PreferredEmailVerificationRepository {
  async insert(input: { personalProfileId: string; email: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }> {
    const db = getDb();
    const [row] = await db.insert(preferredEmailVerificationToken).values(input).returning();
    if (!row) throw new ConfigurationError("preferred_email_verification_token insert returned no row");
    return { id: row.id };
  }

  async findByTokenHash(
    tokenHash: string,
  ): Promise<{ id: string; personalProfileId: string; email: string; expiresAt: Date; consumedAt: Date | null } | null> {
    const db = getDb();
    const rows = await db.select().from(preferredEmailVerificationToken).where(eq(preferredEmailVerificationToken.tokenHash, tokenHash)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, personalProfileId: row.personalProfileId, email: row.email, expiresAt: row.expiresAt, consumedAt: row.consumedAt };
  }

  async consume(id: string): Promise<void> {
    const db = getDb();
    await db.update(preferredEmailVerificationToken).set({ consumedAt: new Date() }).where(eq(preferredEmailVerificationToken.id, id));
  }
}
