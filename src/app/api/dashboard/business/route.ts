import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { AgreementRecord, AgreementService } from "@/lib/agreements/agreementService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import type { BalanceService } from "@/lib/ledger/balanceService";
import { getBalanceService } from "@/lib/ledger/getBalanceService";
import { getProfileAccessService } from "@/lib/profiles/getProfileAccessService";
import type { ProfileAccessService } from "@/lib/profiles/profileAccessService";
import { getStaffService } from "@/lib/staff/getStaffService";
import type { StaffService } from "@/lib/staff/staffService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BALANCE_ELIGIBLE_STATUSES = new Set(["signed", "first_payment_pending", "active", "past_due", "disputed", "paused_by_amendment"]);

interface DashboardAgreementSummary {
  id: string;
  status: string;
}

interface CustomerRef {
  kind: "personal" | "business";
  id: string;
}

interface UpcomingPayment {
  agreementId: string;
  dueDate: string;
  amountMinorUnits: number;
}

interface ActionRequiredItem {
  agreementId: string;
  reason: "awaiting_your_acknowledgment" | "awaiting_your_decision" | "awaiting_your_signature";
}

function customerKey(ref: CustomerRef): string {
  return `${ref.kind}:${ref.id}`;
}

function roleFor(agreement: AgreementRecord, businessProfileId: string): "creditor" | "debtor" | null {
  if (agreement.creditorProfileKind === "business" && agreement.creditorProfileId === businessProfileId) return "creditor";
  if (agreement.debtorProfileKind === "business" && agreement.debtorProfileId === businessProfileId) return "debtor";
  return null;
}

/**
 * Sprint 3's business dashboard, made real for PRSprint 27 — see the personal dashboard route's doc
 * comment for the identical rationale (this handler had the same "nothing exists yet" stub, no longer
 * true since Sprint 5/9's agreement/payment tables and PRSprint 07/08's staff tables shipped).
 * `staffPlaceholder`/`reportsPlaceholder` — dead fields the client never actually rendered — are
 * replaced by a real `staffCount`; no reporting feature exists in this product yet, so that placeholder
 * is simply dropped rather than answered with an invented number.
 */
export function createBusinessDashboardHandler(
  authService: AuthService,
  profileAccess: ProfileAccessService,
  agreementService: AgreementService,
  balanceService: BalanceService,
  staffService: StaffService,
) {
  return async function handleDashboard(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const businessProfileId = new URL(request.url).searchParams.get("businessProfileId");
    if (!businessProfileId) {
      throw new ValidationError("businessProfileId is required.");
    }
    // Throws ForbiddenError/ValidationError if not owned or not active — see profileAccessService.ts.
    await profileAccess.resolveActiveProfile(userId, { kind: "business", businessProfileId });

    const agreements = await agreementService.listAgreements(userId, { kind: "business", id: businessProfileId });

    const today = new Date().toISOString().slice(0, 10);
    let receivablesMinorUnits = 0;
    let payablesMinorUnits = 0;
    const customers = new Map<string, CustomerRef>();
    const upcomingPayments: UpcomingPayment[] = [];
    const requests: ActionRequiredItem[] = [];

    for (const agreement of agreements) {
      const role = roleFor(agreement, businessProfileId);
      const counterparty: CustomerRef =
        role === "creditor"
          ? { kind: agreement.debtorProfileKind, id: agreement.debtorProfileId }
          : { kind: agreement.creditorProfileKind, id: agreement.creditorProfileId };
      customers.set(customerKey(counterparty), counterparty);

      if (BALANCE_ELIGIBLE_STATUSES.has(agreement.status)) {
        const balance = await balanceService.getAgreementBalance(agreement.id);
        if (role === "creditor") receivablesMinorUnits += balance.remainingBalanceMinorUnits;
        if (role === "debtor") payablesMinorUnits += balance.remainingBalanceMinorUnits;

        // Dashboard consistency fix: mirrors the personal dashboard's identical "Upcoming payments"
        // computation exactly, scoped to this business profile's own agreements.
        const detail = await agreementService.getAgreement(agreement.id, userId);
        for (const item of detail.schedule) {
          if (item.dueDate >= today) {
            upcomingPayments.push({ agreementId: agreement.id, dueDate: item.dueDate, amountMinorUnits: item.amountMinorUnits });
          }
        }
        continue;
      }

      // Dashboard consistency fix: mirrors the personal dashboard's identical "Action required"
      // computation. Deliberately does not include relationship-invitation-style items — those are a
      // personal-to-personal connection concept, not applicable to a business acting-as context.
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

    upcomingPayments.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    // Dashboard consistency fix: previously staffService.listStaff, which requires the caller to
    // already have an active business_staff_member row — a business owner (the common case for a
    // dashboard view) has never had one seeded automatically, so this 403'd before returning any
    // summary data at all, and the entire card-grid silently disappeared client-side. countActiveStaff
    // is a plain, ungated count — this route already independently verified ownership above.
    const staffCount = await staffService.countActiveStaff(businessProfileId);

    const summaries: DashboardAgreementSummary[] = agreements.map((a) => ({ id: a.id, status: a.status }));

    return NextResponse.json(
      {
        receivablesMinorUnits,
        payablesMinorUnits,
        agreements: summaries,
        customers: [...customers.values()],
        upcomingPayments: upcomingPayments.slice(0, 10),
        requests,
        staffCount,
      },
      { status: 200 },
    );
  };
}

async function handleDashboard(request: NextRequest): Promise<Response> {
  return createBusinessDashboardHandler(
    getAuthService(),
    getProfileAccessService(),
    getAgreementService(),
    getBalanceService(),
    getStaffService(),
  )(request);
}

export const GET = withErrorHandling("dashboard_business", handleDashboard);
