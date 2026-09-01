import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import { ValidationError } from "@/lib/errors";
import type { PersonalProfileService } from "@/lib/profiles/personalProfileService";
import { getPersonalProfileService } from "@/lib/profiles/getPersonalProfileService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ token: z.string().trim().min(1) });

/** Decision 6: confirms a NEW preferred email — deliberately unauthenticated-token-based, matching AuthService.verifyEmail's own established shape. Never touches user_account.email. */
export function createPersonalProfileVerifyEmailHandler(personalProfileService: PersonalProfileService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("A verification token is required.");
    await personalProfileService.confirmPreferredEmail(parsed.data.token);
    return NextResponse.json({ verified: true }, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createPersonalProfileVerifyEmailHandler(getPersonalProfileService())(request);
}

export const POST = withErrorHandling("personal_profile_verify_email", handlePost);
