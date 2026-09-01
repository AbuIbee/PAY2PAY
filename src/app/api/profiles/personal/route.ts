import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { PersonalProfileService } from "@/lib/profiles/personalProfileService";
import { getPersonalProfileService } from "@/lib/profiles/getPersonalProfileService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const addressSchema = z.object({
  line1: z.string().trim().min(1),
  line2: z.string().trim().optional(),
  city: z.string().trim().min(1),
  state: z.string().trim().min(1),
  postalCode: z.string().trim().min(1),
  country: z.string().trim().min(1),
});

const updateSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  preferredEmail: z.string().trim().email(),
  contactPhone: z.string().trim().min(1),
  address: addressSchema,
});

/** Decision 8/10: only the caller's own fields — never phone/full-address exposure beyond the owner themselves. */
function toResponse(profile: Awaited<ReturnType<PersonalProfileService["getMyProfile"]>>) {
  return {
    firstName: profile.firstName,
    lastName: profile.lastName,
    preferredEmail: profile.preferredEmail,
    preferredEmailVerified: !!profile.preferredEmailVerifiedAt,
    contactPhone: profile.contactPhone,
    address: profile.residentialAddress
      ? {
          line1: profile.residentialAddress.line1,
          line2: profile.residentialAddress.line2 ?? "",
          city: profile.residentialAddress.city,
          state: profile.residentialAddress.state,
          postalCode: profile.residentialAddress.postalCode,
          country: profile.residentialAddress.country,
        }
      : null,
  };
}

export function createPersonalProfileGetHandler(authService: AuthService, personalProfileService: PersonalProfileService) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const profile = await personalProfileService.getMyProfile(userId);
    return NextResponse.json(toResponse(profile), { status: 200 });
  };
}

export function createPersonalProfileUpdateHandler(authService: AuthService, personalProfileService: PersonalProfileService) {
  return async function handleUpdate(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = updateSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid profile is required.");
    }
    const updated = await personalProfileService.updateMyProfile(userId, {
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      preferredEmail: parsed.data.preferredEmail,
      contactPhone: parsed.data.contactPhone,
      address: { ...parsed.data.address, line2: parsed.data.address.line2 || null },
    });
    return NextResponse.json(toResponse(updated), { status: 200 });
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createPersonalProfileGetHandler(getAuthService(), getPersonalProfileService())(request);
}

async function handleUpdate(request: NextRequest): Promise<Response> {
  return createPersonalProfileUpdateHandler(getAuthService(), getPersonalProfileService())(request);
}

export const GET = withErrorHandling("personal_profile_get", handleGet);
export const PUT = withErrorHandling("personal_profile_update", handleUpdate);
