import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { VerificationService } from "@/lib/profiles/verificationService";
import { getVerificationService } from "@/lib/profiles/getVerificationService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Closed-beta remediation (DEF-UAT-020): admin-only visibility into every profile with a pending
 * "full" identity verification request, gated by the `decide_identity_verification` capability.
 * Authorization is enforced inside VerificationService itself (docs/SECURITY_MODEL.md §11's
 * two-independent-layers principle), mirroring AdminRiskEvents' established `roles.requireCapability`
 * pattern.
 */
export function createAdminVerificationListHandler(authService: AuthService, verification: VerificationService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const records = await verification.listPendingVerificationRequests(userId, platformRole);
    return NextResponse.json({ records }, { status: 200 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createAdminVerificationListHandler(getAuthService(), getVerificationService())(request);
}

export const GET = withErrorHandling("admin_verification_list", handleList);
