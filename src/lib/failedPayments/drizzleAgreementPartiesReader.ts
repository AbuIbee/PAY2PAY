import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement } from "@/db/schema";
import type { AgreementPartiesReader } from "./rescheduleRequestService";

export class DrizzleAgreementPartiesReader implements AgreementPartiesReader {
  async getParties(agreementId: string) {
    const db = getDb();
    const rows = await db
      .select({
        creditorProfileKind: agreement.creditorProfileKind,
        creditorProfileId: agreement.creditorProfileId,
        debtorProfileKind: agreement.debtorProfileKind,
        debtorProfileId: agreement.debtorProfileId,
      })
      .from(agreement)
      .where(eq(agreement.id, agreementId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      creditor: { profileKind: row.creditorProfileKind, profileId: row.creditorProfileId },
      debtor: { profileKind: row.debtorProfileKind, profileId: row.debtorProfileId },
    };
  }
}
