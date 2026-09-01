import "server-only";
import { desc, eq, or, and } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, agreementParty, agreementVersion, installmentScheduleItem } from "@/db/schema";
import { ConfigurationError, ValidationError } from "@/lib/errors";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import type { PageParams } from "@/lib/pagination";
import type { AgreementRecord, AgreementRepository, AgreementStatus } from "./agreementService";

/** postgres.js/drizzle FK-violation error code (23503) — surfaces either directly on the thrown error or nested under `.cause`, depending on which query-builder path raised it. */
function isForeignKeyViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  const causeCode = error.cause instanceof Error ? (error.cause as { code?: unknown }).code : undefined;
  return code === "23503" || causeCode === "23503";
}

type Row = typeof agreement.$inferSelect;

function toRecord(row: Row): AgreementRecord {
  return {
    id: row.id,
    creditorProfileKind: row.creditorProfileKind,
    creditorProfileId: row.creditorProfileId,
    debtorProfileKind: row.debtorProfileKind,
    debtorProfileId: row.debtorProfileId,
    status: row.status,
    currency: row.currency,
    country: row.country,
    currentVersionId: row.currentVersionId,
    relationshipId: row.relationshipId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
  };
}

export class DrizzleAgreementRepository implements AgreementRepository {
  async insert(input: {
    creditorProfileKind: ProfileKind;
    creditorProfileId: string;
    debtorProfileKind: ProfileKind;
    debtorProfileId: string;
    currency: string;
    createdByUserId: string;
  }): Promise<AgreementRecord> {
    const db = getDb();
    const [row] = await db.insert(agreement).values(input).returning();
    if (!row) throw new ConfigurationError("agreement insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<AgreementRecord | null> {
    const db = getDb();
    const rows = await db.select().from(agreement).where(eq(agreement.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async updateStatus(id: string, status: AgreementStatus): Promise<void> {
    const db = getDb();
    await db.update(agreement).set({ status }).where(eq(agreement.id, id));
  }

  async setCurrentVersionId(id: string, versionId: string): Promise<void> {
    const db = getDb();
    await db.update(agreement).set({ currentVersionId: versionId }).where(eq(agreement.id, id));
  }

  /**
   * Agreement Lifecycle V2 UAT (Defect 3 — Delete Draft): a true hard delete, only ever called by
   * AgreementService.deleteDraft after it has confirmed the agreement is still an unsent, unsigned
   * draft. Deletes the rows a genuine draft is guaranteed to have (its schedule, its one
   * agreement_version, any agreement_party rows) in dependency order inside one transaction, then the
   * agreement row itself. Deliberately does NOT touch audit_event (this codebase's append-only,
   * hash-chained audit trail — deleting rows from it would corrupt the chain for every later entry;
   * an orphaned agreement_id reference is harmless since audit_event has no real FK to agreement).
   * Any OTHER table this method doesn't know about (evidence, witnesses, disputes, ...) still has a
   * real FK to agreement.id with no cascade — if one somehow has a row despite this being a
   * never-sent draft, the final delete hits a foreign-key violation and this throws a clear
   * ValidationError instead of silently orphaning data.
   */
  async deleteDraft(id: string): Promise<void> {
    const db = getDb();
    try {
      await db.transaction(async (tx) => {
        const versions = await tx.select({ id: agreementVersion.id }).from(agreementVersion).where(eq(agreementVersion.agreementId, id));
        for (const version of versions) {
          await tx.delete(installmentScheduleItem).where(eq(installmentScheduleItem.agreementVersionId, version.id));
        }
        await tx.delete(agreementVersion).where(eq(agreementVersion.agreementId, id));
        await tx.delete(agreementParty).where(eq(agreementParty.agreementId, id));
        await tx.delete(agreement).where(eq(agreement.id, id));
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ValidationError("This draft has related records that must be resolved before it can be deleted.");
      }
      throw error;
    }
  }

  async listForProfile(profileKind: ProfileKind, profileId: string, pageParams?: PageParams): Promise<AgreementRecord[]> {
    const db = getDb();
    const query = db
      .select()
      .from(agreement)
      .where(
        or(
          and(eq(agreement.creditorProfileKind, profileKind), eq(agreement.creditorProfileId, profileId)),
          and(eq(agreement.debtorProfileKind, profileKind), eq(agreement.debtorProfileId, profileId)),
        ),
      )
      .orderBy(desc(agreement.createdAt));
    const rows = pageParams ? await query.limit(pageParams.limit).offset(pageParams.offset) : await query;
    return rows.map(toRecord);
  }

  async listByRelationshipId(relationshipId: string): Promise<AgreementRecord[]> {
    const db = getDb();
    const rows = await db.select().from(agreement).where(eq(agreement.relationshipId, relationshipId)).orderBy(desc(agreement.createdAt));
    return rows.map(toRecord);
  }
}
