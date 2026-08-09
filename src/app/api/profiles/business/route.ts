import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { BusinessProfileService } from "@/lib/profiles/businessProfileService";
import { getBusinessProfileService } from "@/lib/profiles/getBusinessProfileService";
import { US_STATE_CODES } from "@/lib/us-states";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const addressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  state: z.enum(US_STATE_CODES),
  postalCode: z.string().min(1),
});

const createSchema = z.object({
  legalBusinessName: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  entityType: z.string().trim().min(1).max(100),
  businessAddress: addressSchema,
  country: z.string().trim().length(2).default("US"),
  state: z.enum(US_STATE_CODES),
});

export function createBusinessProfileCreateHandler(
  authService: AuthService,
  businessProfileService: BusinessProfileService,
) {
  return async function handleCreate(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid business profile.");
    }
    const profile = await businessProfileService.createBusinessProfile({
      ownerUserId: userId,
      ...parsed.data,
    });
    return NextResponse.json(
      {
        id: profile.id,
        legalBusinessName: profile.legalBusinessName,
        displayName: profile.displayName,
        entityType: profile.entityType,
        status: profile.status,
      },
      { status: 201 },
    );
  };
}

export function createBusinessProfileListHandler(
  authService: AuthService,
  businessProfileService: BusinessProfileService,
) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const profiles = await businessProfileService.listMyBusinessProfiles(userId);
    return NextResponse.json(
      {
        businesses: profiles.map((p) => ({
          id: p.id,
          legalBusinessName: p.legalBusinessName,
          displayName: p.displayName,
          entityType: p.entityType,
          status: p.status,
        })),
      },
      { status: 200 },
    );
  };
}

async function handleCreate(request: NextRequest): Promise<Response> {
  return createBusinessProfileCreateHandler(getAuthService(), getBusinessProfileService())(request);
}

async function handleList(request: NextRequest): Promise<Response> {
  return createBusinessProfileListHandler(getAuthService(), getBusinessProfileService())(request);
}

export const POST = withErrorHandling("business_profile_create", handleCreate);
export const GET = withErrorHandling("business_profile_list", handleList);
