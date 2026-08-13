import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { achMandate } from "@/db/schema";
import type { AchMandateService } from "@/lib/ach/achMandateService";
import type { MandateReader } from "./relationshipService";
import type { PartyRef } from "./relationshipInvitationService";

/**
 * ACH connector (Phase 20) adapter: implements RelationshipService's `MandateReader` entirely by
 * delegating authorization to Sprint 11's `AchMandateService.authorize` — no mandate logic is
 * reimplemented here. The one thing Sprint 11 has no concept of is `ach_mandate.financial_account_id`
 * (Sprint 18A's own additive column, see ach.ts) — set via a single narrow update immediately after
 * authorization, the only direct-SQL touch in this adapter.
 */
export class AchMandateFinancialAccountAdapter implements MandateReader {
  constructor(private readonly achMandateService: AchMandateService) {}

  async isActiveForAgreement(agreementId: string): Promise<boolean> {
    return this.achMandateService.isActiveForAgreement(agreementId);
  }

  /** Idempotent — if an active mandate already exists for this agreement (e.g. a retried linkAgreement call), this is a no-op rather than throwing AchMandateService.authorize's own "already exists" error. */
  async authorizeFromFinancialAccount(input: {
    agreementId: string;
    payer: PartyRef;
    financialAccountId: string;
    bankAccountRef: string;
    actingUserId: string;
  }): Promise<void> {
    const existing = await this.achMandateService.getActiveMandate(input.agreementId);
    if (existing) return;
    const mandate = await this.achMandateService.authorize({
      agreementId: input.agreementId,
      payer: { profileKind: input.payer.kind, profileId: input.payer.id },
      bankAccountRef: input.bankAccountRef,
      actingUserId: input.actingUserId,
    });
    const db = getDb();
    await db.update(achMandate).set({ financialAccountId: input.financialAccountId }).where(eq(achMandate.id, mandate.id));
  }
}
