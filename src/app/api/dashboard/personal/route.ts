import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { AgreementRecord, AgreementService } from "@/lib/agreements/agreementService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import type { BalanceService } from "@/lib/ledger/balanceService";
import { getBalanceService } from "@/lib/ledger/getBalanceService";
import type { ProfileAccessService } from "@/lib/profiles/profileAccessService";
import { getProfileAccessService } from "@/lib/profiles/getProfileAccessService";
import type { RelationshipInvitationService } from "@/lib/relationships/relationshipInvitationService";
import { getRelationshipInvitationService } from "@/lib/relationships/getRelationshipInvitationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PRSprint 27 (docs/prsprints/PRSPRINT_27_DASHBOARDS_ONBOARDING_ROLE_AWARE_UX.md): an agreement only
 * has a real, ledger-reconstructable balance once both parties have signed — draft/pre-signature
 * statuses (draft, awaiting_debtor_acknowledgment, awaiting_creditor_acceptance, awaiting_signatures)
 * have no BalanceService.getAgreementBalance answer yet (AgreementTermsReader keys off a *signed*
 * version's terms). closed/paid_in_full/settled_in_full/mutually_canceled/closed are resolved — no
 * outstanding balance to surface on a dashboard.
 */
const BALANCE_ELIGIBLE_STATUSES = new Set(["signed", "first_payment_pending", "active", "past_due", "disputed", "paused_by_amendment"]);

interface DashboardAgreementSummary {
  id: string;
  status: string;
}

interface UpcomingPayment {
  agreementId: string;
  dueDate: string;
  amountMinorUnits: number;
}

interface ActionRequiredItem {
  agreementId: string | null;
  reason: "awaiting_your_acknowledgment" | "awaiting_your_decision" | "awaiting_your_signature" | "pending_connection_invitation";
  invitationId?: string;
}

function roleFor(agreement: AgreementRecord, profileId: string): "creditor" | "debtor" | null {
  if (agreement.creditorProfileKind === "personal" && agreement.creditorProfileId === profileId) return "creditor";
  if (agreement.debtorProfileKind === "personal" && agreement.debtorProfileId === profileId) return "debtor";
  return null;
}

/**
 * Sprint 3's personal dashboard, made real for PRSprint 27 — the original handler unconditionally
 * returned zeros/empty arrays ("No agreement/payment/request tables exist yet"), which stopped being
 * true as of Sprint 5/9/16 but was never revisited. `moneyIOweMinorUnits`/`moneyOwedToMeMinorUnits`
 * are the ledger-reconstructed remaining balance (BalanceService — never a cached/mutable field) summed
 * across every signed, unresolved agreement where this profile is debtor/creditor respectively.
 * `requests` surfaces agreements genuinely awaiting *this user's* decision (not yet signed by them, or
 * awaiting their creditor-acceptance/debtor-acknowledgment) — "action required" per the spec, computed
 * from data already on hand rather than a second unrelated query.
 */
export function createPersonalDashboardHandler(
  authService: AuthService,
  profileAccess: ProfileAccessService,
  agreementService: AgreementService,
  balanceService: BalanceService,
  invitationService: RelationshipInvitationService,
) {
  return async function handleDashboard(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const profile = await profileAccess.resolveActiveProfile(userId, { kind: "personal" });
    const profileId = profile.personalProfileId!;

    const agreements = await agreementService.listAgreements(userId, { kind: "personal", id: profileId });

    const today = new Date().toISOString().slice(0, 10);
    let moneyIOweMinorUnits = 0;
    let moneyOwedToMeMinorUnits = 0;
    const upcomingPayments: UpcomingPayment[] = [];
    const requests: ActionRequiredItem[] = [];

    for (const agreement of agreements) {
      const role = roleFor(agreement, profileId);

      if (BALANCE_ELIGIBLE_STATUSES.has(agreement.status)) {
        const balance = await balanceService.getAgreementBalance(agreement.id);
        if (role === "debtor") moneyIOweMinorUnits += balance.remainingBalanceMinorUnits;
        if (role === "creditor") moneyOwedToMeMinorUnits += balance.remainingBalanceMinorUnits;

        const detail = await agreementService.getAgreement(agreement.id, userId);
        for (const item of detail.schedule) {
          if (item.dueDate >= today) {
            upcomingPayments.push({ agreementId: agreement.id, dueDate: item.dueDate, amountMinorUnits: item.amountMinorUnits });
          }
        }
        continue;
      }

      if (agreement.status === "awaiting_creditor_acceptance" && role === "creditor") {
        requests.push({ agreementId: agreement.id, reason: "awaiting_your_decision" });
      } else if (agreement.status === "awaiting_debtor_acknowledgment" && role === "debtor") {
        requests.push({ agreementId: agreement.id, reason: "awaiting_your_acknowledgment" });
      } else if (agreement.status === "awaiting_signatures") {
        const detail = await agreementService.getAgreement(agreement.id, userId);
        const alreadySigned = role === "debtor" ? detail.version.debtorSignedAt : detail.version.creditorSignedAt;
        if (!alreadySigned) requests.push({ agreementId: agreement.id, reason: "awaiting_your_signature" });
      }
    }

    // Closed-beta remediation (DEF-UAT-007): the "Action required" count previously only counted
    // agreement-lifecycle items, so it stayed 0 even when a real pending connection invitation
    // existed for this user — the very first thing a real invitee needs to act on.
    const pendingInvitations = await invitationService.listPendingForInvitee(userId);
    for (const invitation of pendingInvitations) {
      requests.push({ agreementId: null, reason: "pending_connection_invitation", invitationId: invitation.id });
    }

    upcomingPayments.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    const summaries: DashboardAgreementSummary[] = agreements.map((a) => ({ id: a.id, status: a.status }));

    return NextResponse.json(
      {
        moneyIOweMinorUnits,
        moneyOwedToMeMinorUnits,
        agreements: summaries,
        upcomingPayments: upcomingPayments.slice(0, 10),
        requests,
      },
      { status: 200 },
    );
  };
}

async function handleDashboard(request: NextRequest): Promise<Response> {
  return createPersonalDashboardHandler(
    getAuthService(),
    getProfileAccessService(),
    getAgreementService(),
    getBalanceService(),
    getRelationshipInvitationService(),
  )(request);
}

export const GET = withErrorHandling("dashboard_personal", handleDashboard);
