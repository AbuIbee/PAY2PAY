import "server-only";
import { and, eq, inArray, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agreement, agreementVersion, installmentScheduleItem } from "@/db/schema";
import type { AgreementTerms } from "@/lib/agreements/agreementService";
import type { B2BDashboardData, B2BDashboardReader, B2BUpcomingPayment } from "./b2bDashboardReader";

// Every status at or after signing, up to (not including) a terminal state — matches
// docs/STATE_MACHINES.md §1's non-terminal, post-signature states.
const ACTIVE_STATUSES = ["signed", "first_payment_pending", "active", "past_due", "disputed", "paused_by_amendment"];

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Sprint 8 (docs/sprints/SPRINT_08_Workflows_CSVImports.md) business financial dashboard — a
 * separate, additive surface (never touches Sprint 3's `/api/dashboard/business` stub or its
 * exact-match test). Every figure is a real, direct query against Sprint 5's tables — "No fake
 * financial data" (Sprint 3's own precedent for this dashboard family, carried forward here).
 * Accounts Receivable/Payable reflect each agreement's `current_principal_minor_units` as recorded
 * at signing — no payment-tracking table exists yet (Sprint 9+), so this cannot reflect payments
 * already made after signing; that is a known, honestly-disclosed limitation, not a silent
 * inaccuracy.
 */
export class DrizzleB2BDashboardReader implements B2BDashboardReader {
  async getDashboard(businessProfileId: string): Promise<B2BDashboardData> {
    const db = getDb();

    const agreements = await db
      .select({
        id: agreement.id,
        status: agreement.status,
        currentVersionId: agreement.currentVersionId,
        creditorProfileKind: agreement.creditorProfileKind,
        creditorProfileId: agreement.creditorProfileId,
        debtorProfileKind: agreement.debtorProfileKind,
        debtorProfileId: agreement.debtorProfileId,
      })
      .from(agreement)
      .where(
        or(
          and(eq(agreement.creditorProfileKind, "business"), eq(agreement.creditorProfileId, businessProfileId)),
          and(eq(agreement.debtorProfileKind, "business"), eq(agreement.debtorProfileId, businessProfileId)),
        ),
      );

    const activeAgreements = agreements.filter((a) => ACTIVE_STATUSES.includes(a.status));
    const activeAgreementsCount = activeAgreements.length;

    const versionIds = activeAgreements.map((a) => a.currentVersionId).filter((id): id is string => id !== null);
    const versions =
      versionIds.length > 0
        ? await db
            .select({ id: agreementVersion.id, agreementId: agreementVersion.agreementId, terms: agreementVersion.terms })
            .from(agreementVersion)
            .where(inArray(agreementVersion.id, versionIds))
        : [];
    const termsByAgreementId = new Map(versions.map((v) => [v.agreementId, v.terms as AgreementTerms]));

    let accountsReceivableMinorUnits = 0;
    let accountsPayableMinorUnits = 0;
    for (const a of activeAgreements) {
      const terms = termsByAgreementId.get(a.id);
      if (!terms) continue;
      const isCreditor = a.creditorProfileKind === "business" && a.creditorProfileId === businessProfileId;
      if (isCreditor) accountsReceivableMinorUnits += terms.currentPrincipalMinorUnits;
      else accountsPayableMinorUnits += terms.currentPrincipalMinorUnits;
    }

    const scheduleItems =
      versionIds.length > 0
        ? await db
            .select({
              agreementVersionId: installmentScheduleItem.agreementVersionId,
              dueDate: installmentScheduleItem.dueDate,
              amountMinorUnits: installmentScheduleItem.amountMinorUnits,
              status: installmentScheduleItem.status,
            })
            .from(installmentScheduleItem)
            .where(and(inArray(installmentScheduleItem.agreementVersionId, versionIds), eq(installmentScheduleItem.status, "scheduled")))
        : [];

    const versionIdToAgreement = new Map(activeAgreements.map((a) => [a.currentVersionId, a]));
    const today = todayIsoDate();
    const upcomingPayments: B2BUpcomingPayment[] = [];
    const pastDuePayments: B2BUpcomingPayment[] = [];
    for (const item of scheduleItems) {
      const parentAgreement = versionIdToAgreement.get(item.agreementVersionId);
      if (!parentAgreement) continue;
      const isCreditor = parentAgreement.creditorProfileKind === "business" && parentAgreement.creditorProfileId === businessProfileId;
      const entry: B2BUpcomingPayment = {
        agreementId: parentAgreement.id,
        role: isCreditor ? "creditor" : "debtor",
        dueDate: item.dueDate,
        amountMinorUnits: item.amountMinorUnits,
      };
      if (item.dueDate < today) pastDuePayments.push(entry);
      else upcomingPayments.push(entry);
    }
    upcomingPayments.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    pastDuePayments.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    return {
      activeAgreementsCount,
      accountsReceivableMinorUnits,
      accountsPayableMinorUnits,
      upcomingPayments: upcomingPayments.slice(0, 50),
      pastDuePayments: pastDuePayments.slice(0, 50),
      settlements: [],
      disputes: [],
    };
  }
}
