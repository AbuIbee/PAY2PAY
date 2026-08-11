import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { getKycVerificationService } from "@/lib/kyc/getKycVerificationService";
import type { KycVerificationService } from "@/lib/kyc/kycVerificationService";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const individualSchema = z.object({
  kind: z.literal("individual"),
  profileId: z.string().uuid(),
  legalName: z.string().trim().min(1).max(200),
  dateOfBirth: z.string().trim().min(1).max(20),
  governmentIdDocumentRef: z.string().trim().min(1).max(500),
  selfieRef: z.string().trim().min(1).max(500),
});

const businessSchema = z.object({
  kind: z.literal("business"),
  profileId: z.string().uuid(),
  legalBusinessName: z.string().trim().min(1).max(200),
  registrationNumber: z.string().trim().min(1).max(100),
  representativeGovernmentIdRef: z.string().trim().min(1).max(500),
  bankAccountOwnershipRef: z.string().trim().min(1).max(500),
});

const kycSubmitSchema = z.discriminatedUnion("kind", [individualSchema, businessSchema]);

/**
 * Sprint 9: matches Sprint 3's own authorization boundary for verification submission — the caller
 * must own the profile being submitted (same "no route calls this without an authorization check"
 * discipline verificationService.ts's doc comment already established), enforced here rather than
 * inside KycVerificationService, mirroring submitFullVerificationRequest's own design (Sprint 3
 * leaves ownership enforcement to the caller, not the service).
 */
export function createKycSubmitHandler(authService: AuthService, kycVerificationService: KycVerificationService) {
  return async function handleSubmit(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = kycSubmitSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid KYC/KYB submission is required.");
    }

    const profileOwners = new DrizzleProfileOwnerReader();
    const profileKind = parsed.data.kind === "individual" ? "personal" : "business";
    const ownerUserId = await profileOwners.getOwnerUserId(profileKind, parsed.data.profileId);
    if (ownerUserId !== userId) {
      throw new ForbiddenError("You may only submit verification for your own profile.");
    }

    const result =
      parsed.data.kind === "individual"
        ? await kycVerificationService.submitIndividualVerification(parsed.data)
        : await kycVerificationService.submitBusinessVerification(parsed.data);
    return NextResponse.json({ providerVerificationId: result.providerVerificationId }, { status: 201 });
  };
}

async function handleSubmit(request: NextRequest): Promise<Response> {
  return createKycSubmitHandler(getAuthService(), getKycVerificationService())(request);
}

export const POST = withErrorHandling("kyc_submit", handleSubmit);
