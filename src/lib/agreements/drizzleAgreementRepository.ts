import "server-only";
import { desc, eq, or, and, inArray } from "drizzle-orm";
import { getDb, type Database } from "@/db/client";
import { agreement, agreementParty, agreementVersion, installmentScheduleItem } from "@/db/schema";
import { ConfigurationError, ValidationError } from "@/lib/errors";
import type { ProfileKind } from "@/lib/profiles/verificationService";
import type { PageParams } from "@/lib/pagination";
import type { AgreementRecord, AgreementRepository, AgreementStatus } from "./agreementService";
import type { AgreementLockTestHooks } from "./drizzleSigningApplicationRepository";

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
  /**
   * R07 corrective pass: `db` is injectable (defaulting to the shared production singleton) solely
   * so `*.postgres.test.ts` concurrency suites can hand two instances of this SAME class two
   * genuinely distinct PostgreSQL connections — e.g. racing `updateStatusIfCurrentlyIn` (cancellation)
   * against `DrizzleSigningApplicationRepository.applySigningAtomically` (signing) on real, separate
   * connections. Every production call site (`new DrizzleAgreementRepository()`, no argument) is
   * unaffected.
   */
  constructor(
    private readonly db: Database = getDb(),
    /**
     * FINAL corrective pass: test-only affordance, identical in shape and purpose to
     * `DrizzleSigningApplicationRepository`'s/`DrizzleRevisionApplicationRepository`'s own `hooks` —
     * see `AgreementLockTestHooks`'s own doc comment. Only ever set by `*.postgres.test.ts` suites to
     * deterministically pause `applyAcceptanceTransitionAtomically` mid-transaction; every production
     * call site (`new DrizzleAgreementRepository()`, no second argument) is unaffected.
     */
    private readonly hooks?: AgreementLockTestHooks,
  ) {}

  async insert(input: {
    creditorProfileKind: ProfileKind;
    creditorProfileId: string;
    debtorProfileKind: ProfileKind;
    debtorProfileId: string;
    currency: string;
    createdByUserId: string;
  }): Promise<AgreementRecord> {
    const db = this.db;
    const [row] = await db.insert(agreement).values(input).returning();
    if (!row) throw new ConfigurationError("agreement insert returned no row");
    return toRecord(row);
  }

  async findById(id: string): Promise<AgreementRecord | null> {
    const db = this.db;
    const rows = await db.select().from(agreement).where(eq(agreement.id, id)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async updateStatus(id: string, status: AgreementStatus): Promise<void> {
    const db = this.db;
    await db.update(agreement).set({ status }).where(eq(agreement.id, id));
  }

  /**
   * R05 (DB integrity & concurrency hardening): one atomic `UPDATE ... WHERE id = ? AND status IN
   * (...)` — see this method's own doc comment in agreementService.ts. `.returning()` coming back
   * empty is how Postgres tells us the WHERE clause matched no row (status had already moved on),
   * distinguishing that from "row doesn't exist at all" the same way every other conditional-update
   * pattern in this codebase does (e.g. AgreementInvitationRepository.claimAcceptance's identical
   * `status IN (pending, viewed)` guard).
   */
  async updateStatusIfCurrentlyIn(id: string, expectedStatuses: readonly AgreementStatus[], newStatus: AgreementStatus): Promise<boolean> {
    const db = this.db;
    const rows = await db
      .update(agreement)
      .set({ status: newStatus })
      .where(and(eq(agreement.id, id), inArray(agreement.status, [...expectedStatuses])))
      .returning({ id: agreement.id });
    return rows.length > 0;
  }

  /**
   * FINAL corrective pass (Codex: close the accept-vs-general-revision race) — see
   * `AgreementRepository.applyAcceptanceTransitionAtomically`'s own doc comment in agreementService.ts
   * for the exact staleness window this closes. Lock order (`agreement` then its current
   * `agreement_version`, both `FOR UPDATE`) intentionally matches
   * `DrizzleSigningApplicationRepository`/`DrizzleRevisionApplicationRepository` exactly — this method
   * doesn't itself need to WRITE to `agreement_version` (accept never mutates version content), but
   * locking it too proves it's genuinely the row `expectedCurrentVersionId` claims it is and keeps
   * this write serialized against every other transition that touches the same pair.
   */
  async applyAcceptanceTransitionAtomically(input: {
    agreementId: string;
    expectedCurrentVersionId: string;
    expectedStatuses: readonly AgreementStatus[];
    newStatus: AgreementStatus;
  }): Promise<boolean> {
    const db = this.db;
    return db.transaction(async (tx) => {
      if (this.hooks?.beforeAgreementLock) await this.hooks.beforeAgreementLock();
      const agreementRows = await tx.select().from(agreement).where(eq(agreement.id, input.agreementId)).for("update").limit(1);
      if (this.hooks?.afterAgreementLock) await this.hooks.afterAgreementLock();
      const agreementRow = agreementRows[0];
      if (!agreementRow) return false;
      if (!input.expectedStatuses.includes(agreementRow.status)) return false;
      if (agreementRow.currentVersionId !== input.expectedCurrentVersionId) return false;

      const versionRows = await tx
        .select()
        .from(agreementVersion)
        .where(eq(agreementVersion.id, input.expectedCurrentVersionId))
        .for("update")
        .limit(1);
      const versionRow = versionRows[0];
      if (!versionRow || versionRow.agreementId !== input.agreementId) return false;

      await tx.update(agreement).set({ status: input.newStatus }).where(eq(agreement.id, input.agreementId));
      return true;
    });
  }

  async setCurrentVersionId(id: string, versionId: string): Promise<void> {
    const db = this.db;
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
    const db = this.db;
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
    const db = this.db;
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
    const db = this.db;
    const rows = await db.select().from(agreement).where(eq(agreement.relationshipId, relationshipId)).orderBy(desc(agreement.createdAt));
    return rows.map(toRecord);
  }
}
