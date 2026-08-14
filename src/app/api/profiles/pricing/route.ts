import { NextResponse, type NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { getActiveProfileSelectorFromCookie } from "@/lib/profiles/activeProfileCookie";
import { getProfileAccessService } from "@/lib/profiles/getProfileAccessService";
import type { ProfileAccessService } from "@/lib/profiles/profileAccessService";
import { getPricingService } from "@/lib/pricing/getPricingService";
import type { PricingService } from "@/lib/pricing/pricingService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sprint 18B: thin read-only route over PricingService.getActivePlan for the caller's own active profile. No route exposed this before. */
export function createPricingGetHandler(authService: AuthService, profileAccess: ProfileAccessService, pricing: PricingService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const cookieSelector = getActiveProfileSelectorFromCookie(request);
    const active = await profileAccess.resolveActiveProfile(userId, cookieSelector ?? { kind: "personal" });
    const profileId = active.kind === "personal" ? active.personalProfileId! : active.businessProfileId!;
    const [plan, usage] = await Promise.all([
      pricing.getActivePlan(active.kind, profileId),
      pricing.getFreeTierUsage(active.kind, profileId),
    ]);
    return NextResponse.json({ plan, usage }, { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createPricingGetHandler(getAuthService(), getProfileAccessService(), getPricingService())(request);
}

export const GET = withErrorHandling("profiles_pricing_get", handleGet);
