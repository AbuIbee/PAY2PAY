import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { BusinessOnboardingService } from "@/lib/organizations/businessOnboardingService";
import { getBusinessOnboardingService } from "@/lib/organizations/getBusinessOnboardingService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  organizationId: z.string().uuid(),
  // Section 9: accepted here only to be passed straight through to the verification provider —
  // never persisted (see BusinessVerificationService's own doc comment).
  taxId: z.string().trim().min(4).max(20),
});

/**
 * Requirement 3/Section 9: production verification is currently NOT_CONFIGURED
 * (BusinessVerificationProvider) — BusinessOnboardingService.submitVerification lets that
 * `ProviderNotAvailableError` propagate directly; withErrorHandling turns it into a 503 with a
 * clear "feature not available" message, never a fabricated success.
 */
export function createOnboardingVerificationHandler(authService: AuthService, onboarding: BusinessOnboardingService) {
  return async function handleSubmit(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid Tax ID is required.");
    }

    const record = await onboarding.submitVerification({ actingUserId: userId, organizationId: parsed.data.organizationId, taxId: parsed.data.taxId });
    return NextResponse.json({ status: record.status, submittedAt: record.submittedAt }, { status: 201 });
  };
}

async function handleSubmit(request: NextRequest): Promise<Response> {
  return createOnboardingVerificationHandler(getAuthService(), getBusinessOnboardingService())(request);
}

export const POST = withErrorHandling("organizations_onboarding_verification", handleSubmit);
