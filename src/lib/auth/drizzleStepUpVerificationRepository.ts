import "server-only";
import { and, desc, eq, gt } from "drizzle-orm";
import { getDb } from "@/db/client";
import { stepUpVerification } from "@/db/schema";
import type { StepUpVerificationRepository } from "./mfaService";

export class DrizzleStepUpVerificationRepository implements StepUpVerificationRepository {
  async insert(input: { sessionId: string; expiresAt: Date }): Promise<void> {
    const db = getDb();
    await db.insert(stepUpVerification).values(input);
  }

  async findActiveForSession(sessionId: string, now: Date): Promise<{ expiresAt: Date } | null> {
    const db = getDb();
    const rows = await db
      .select({ expiresAt: stepUpVerification.expiresAt })
      .from(stepUpVerification)
      .where(and(eq(stepUpVerification.sessionId, sessionId), gt(stepUpVerification.expiresAt, now)))
      .orderBy(desc(stepUpVerification.expiresAt))
      .limit(1);
    return rows[0] ?? null;
  }
}
