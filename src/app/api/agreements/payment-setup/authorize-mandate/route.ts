import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementService } from "@/lib/agreements/agreementService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import type { RelationshipFinancialAccountService } from "@/lib/relationships/relationshipFinancialAccountService";
import { getRelationshipFinancialAccountService } from "@/lib/relationships/getRelationshipFinancialAccountService";
import type { AchMandateService } from "@/lib/ach/achMandateService";
import { getAchMandateService } from "@/lib/ach/getAchMandateService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ForbiddenError, RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUTHORIZE_LIMIT_PER_USER = 10;
const AUTHORIZE_WINDOW_MS = 60 * 60 * 1000;

const bodySchema = z.object({ agreementId: z.string().uuid() });

/**
 * Restore agreement payment functionality: the one-click "Set up payment method" CTA target for a
 * debtor who has already assigned a relationship-level funding account but has never authorized
 * *this specific agreement* to debit it (AchPaymentService requires an agreement-scoped mandate —
 * see AchMandateService's own doc comment). Deliberately takes only `agreementId` from the client —
 * the funding account's `providerAccountRef` is resolved server-side from the already-assigned
 * relationship account, so the browser never has to carry that reference itself.
 */
export function createAuthorizeAgreementMandateHandler(
  authService: AuthService,
  agreementService: AgreementService,
  relationshipAccounts: RelationshipFinancialAccountService,
  mandates: AchMandateService,
) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "agreementId is required.");
    }
    if (!(await checkRateLimit(`agreement-mandate-authorize:user:${userId}`, AUTHORIZE_LIMIT_PER_USER, AUTHORIZE_WINDOW_MS))) {
      throw new RateLimitedError("Too many attempts. Please try again later.");
    }

    const { agreementId } = parsed.data;
    const { agreement } = await agreementService.getAgreement(agreementId, userId);
    const myRole = await agreementService.resolvePartyRole(agreementId, userId);
    if (myRole !== "debtor") {
      throw new ForbiddenError("Only the debtor can authorize a payment mandate for this agreement.");
    }
    if (!agreement.relationshipId) {
      throw new ValidationError("This agreement has no linked relationship to source a funding account from.");
    }

    const assignments = await relationshipAccounts.getRelationshipAccounts(agreement.relationshipId, userId);
    const funding = assignments.find(
      (a) => a.usage === "funding" && a.status === "active" && a.financialAccount.status !== "disabled",
    );
    if (!funding) {
      throw new ValidationError("Add a funding account before authorizing payments on this agreement.");
    }

    // TEMPORARY PAYMENT SAFETY (connection P2P-EZ2R-V3MM remediation): the funding slot's account
    // ownership is already enforced at assignment time (RelationshipFinancialAccountService.
    // requireUsageMatchesRole — only the debtor may ever occupy the funding slot), but a mandate
    // authorizes debiting real money, so this is verified again here rather than trusted transitively.
    // Fail closed: never silently substitute another account or proceed with a source/debtor mismatch.
    const fundingOwnerMatchesDebtor =
      (agreement.debtorProfileKind === "personal" && funding.financialAccount.individualProfileId === agreement.debtorProfileId) ||
      (agreement.debtorProfileKind === "business" && funding.financialAccount.organizationId === agreement.debtorProfileId);
    if (!fundingOwnerMatchesDebtor) {
      logger.error("payment_routing_funding_owner_mismatch", {
        agreementId,
        relationshipId: agreement.relationshipId,
        financialAccountId: funding.financialAccount.id,
        assignmentId: funding.id,
      });
      throw new ForbiddenError("This agreement's funding account could not be verified. Please contact support.");
    }

    const mandate = await mandates.authorize({
      agreementId,
      payer: { profileKind: agreement.debtorProfileKind, profileId: agreement.debtorProfileId },
      bankAccountRef: funding.financialAccount.providerAccountRef,
      actingUserId: userId,
    });
    return NextResponse.json({ id: mandate.id, status: mandate.status }, { status: 201 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAuthorizeAgreementMandateHandler(
    getAuthService(),
    getAgreementService(),
    getRelationshipFinancialAccountService(),
    getAchMandateService(),
  )(request);
}

export const POST = withErrorHandling("agreement_payment_setup_authorize_mandate", handlePost);
