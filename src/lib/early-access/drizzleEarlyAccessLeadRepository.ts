import "server-only";
import { getDb } from "@/db/client";
import { earlyAccessLead } from "@/db/schema";
import { ConfigurationError } from "@/lib/errors";
import type {
  EarlyAccessLeadInput,
  EarlyAccessLeadRecord,
  EarlyAccessLeadRepository,
} from "./earlyAccessLeadRepository";

/**
 * Real, Postgres-backed EarlyAccessLeadRepository. Not exercised by any test
 * (no live database exists in this environment) — mirrors
 * DrizzleUserAccountRepository's pattern (src/lib/auth/drizzleUserAccountRepository.ts).
 */
export class DrizzleEarlyAccessLeadRepository implements EarlyAccessLeadRepository {
  async upsertByEmail(input: EarlyAccessLeadInput): Promise<EarlyAccessLeadRecord> {
    const db = getDb();
    const [row] = await db
      .insert(earlyAccessLead)
      .values(input)
      .onConflictDoUpdate({
        target: earlyAccessLead.email,
        set: {
          name: input.name,
          accountType: input.accountType,
          businessName: input.businessName,
          state: input.state,
          intendedUse: input.intendedUse,
          expectedAgreementsPerMonth: input.expectedAgreementsPerMonth,
          notes: input.notes,
          source: input.source,
          consentVersion: input.consentVersion,
          // created_at intentionally left untouched on update — it should
          // reflect the first time this email expressed interest.
        },
      })
      .returning({ id: earlyAccessLead.id });
    if (!row) {
      throw new ConfigurationError("early_access_leads upsert returned no row");
    }
    return { id: row.id };
  }
}
