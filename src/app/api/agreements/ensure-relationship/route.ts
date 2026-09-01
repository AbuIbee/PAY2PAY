import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementService } from "@/lib/agreements/agreementService";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ensureRelationshipSchema = z.object({ agreementId: z.string().uuid() });

/**
 * Production defect remediation (canonical connection) — Correction 1: GET-driven reads
 * (GET /api/agreements/progress) must never mutate. This is the one explicit, idempotent POST mutation
 * the Agreement page invokes automatically (never a manual connection picker) whenever it observes
 * Step 2 complete + `relationship_id` still null — see AgreementDetail.tsx's auto-invoke effect and
 * AgreementSetupRetryPanel.
 *
 * Thin wrapper over AgreementService.ensureRelationshipLinked, which already provides every required
 * property on its own: `getAgreement`'s `authorizeEitherParty` gate rejects an unrelated/unauthorized
 * caller before any write happens (agreement-authorized, unrelated User C impossible); resolution is
 * exact-party-only (never by name/email); it is idempotent (a no-op once already linked, or while
 * still pre-acceptance); and it is race-safe (delegates to the same `pairResolver` advisory-lock path
 * Decision 3 already uses at accept time — never a second, divergent mechanism). `requireSession`
 * supplies the authentication requirement.
 */
export function createEnsureRelationshipHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleEnsureRelationship(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = ensureRelationshipSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "agreementId is required.");
    }
    const relationshipId = await agreementService.ensureRelationshipLinked(parsed.data.agreementId, userId);
    return NextResponse.json({ relationshipId }, { status: 200 });
  };
}

async function handleEnsureRelationship(request: NextRequest): Promise<Response> {
  return createEnsureRelationshipHandler(getAuthService(), getAgreementService())(request);
}

export const POST = withErrorHandling("agreement_ensure_relationship", handleEnsureRelationship);
