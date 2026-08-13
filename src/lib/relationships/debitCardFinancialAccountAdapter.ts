import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { debitCardMethod } from "@/db/schema";
import type { DebitCardMethodService } from "@/lib/debitCard/debitCardMethodService";
import type { CardMethodReader } from "./relationshipService";
import type { PartyRef } from "./relationshipInvitationService";

/**
 * Debit-card connector (Phase 21) adapter: implements RelationshipService's `CardMethodReader` entirely
 * by delegating registration to Sprint 12's `DebitCardMethodService.registerCard` — no card logic is
 * reimplemented here. The one thing Sprint 12 has no concept of is `debit_card_method.financial_account_id`
 * (Sprint 18A's own additive column, see debitCard.ts) — set via a single narrow update immediately
 * after registration, the only direct-SQL touch in this adapter. Mirrors AchMandateFinancialAccountAdapter
 * exactly.
 */
export class DebitCardFinancialAccountAdapter implements CardMethodReader {
  constructor(private readonly debitCardMethodService: DebitCardMethodService) {}

  async isActiveForAgreement(agreementId: string): Promise<boolean> {
    return (await this.debitCardMethodService.getActiveCard(agreementId)) !== null;
  }

  /** Idempotent — if an active card already exists for this agreement (e.g. a retried linkAgreement call), this is a no-op rather than throwing DebitCardMethodService.registerCard's own "already exists" error. */
  async registerFromFinancialAccount(input: {
    agreementId: string;
    payer: PartyRef;
    financialAccountId: string;
    cardToken: string;
    cardLast4: string;
    cardBrand: string | null;
    expiresAtMonth: number;
    expiresAtYear: number;
    actingUserId: string;
  }): Promise<void> {
    const existing = await this.debitCardMethodService.getActiveCard(input.agreementId);
    if (existing) return;
    const card = await this.debitCardMethodService.registerCard({
      agreementId: input.agreementId,
      payer: { profileKind: input.payer.kind, profileId: input.payer.id },
      cardToken: input.cardToken,
      cardLast4: input.cardLast4,
      cardBrand: input.cardBrand,
      expiresAtMonth: input.expiresAtMonth,
      expiresAtYear: input.expiresAtYear,
      actingUserId: input.actingUserId,
    });
    const db = getDb();
    await db.update(debitCardMethod).set({ financialAccountId: input.financialAccountId }).where(eq(debitCardMethod.id, card.id));
  }
}
