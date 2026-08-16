import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement } from "@/db/schema";
import type { AgreementPartiesReader } from "./paymentService";

/**
 * PRSprint 09 (docs/prsprints/PRSPRINT_09_CANONICAL_AGREEMENT_PARTICIPANT_MODEL.md): reads only
 * `agreement.creditorProfileKind`/`creditorProfileId`/`debtorProfileKind`/`debtorProfileId` — the
 * same canonical, single-row-per-agreement columns every other authorization check in this codebase
 * (AgreementService's own party-authorization pattern) reads from, never the write-only
 * `agreement_party` historical snapshot rows.
 */
export class DrizzleAgreementPartiesReader implements AgreementPartiesReader {
  async getParties(agreementId: string): ReturnType<AgreementPartiesReader["getParties"]> {
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
