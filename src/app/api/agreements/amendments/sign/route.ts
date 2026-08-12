import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AmendmentService } from "@/lib/amendments/amendmentService";
import { getAmendmentService } from "@/lib/amendments/getAmendmentService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getClientIp } from "@/lib/request-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const signSchema = z.object({ amendmentId: z.string().uuid() });

/** Dual-signature collection — once both parties have signed, the amendment applies immediately (new immutable agreement_version). */
export function createAmendmentSignHandler(authService: AuthService, amendmentService: AmendmentService) {
  return async function handlePost(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = signSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid amendment id is required.");
    }
    const record = await amendmentService.signAmendment({
      amendmentId: parsed.data.amendmentId,
      actingUserId: userId,
      ipAddress: getClientIp(request),
      deviceInfo: { userAgent: request.headers.get("user-agent") },
    });
    return NextResponse.json(record, { status: 200 });
  };
}

async function handlePost(request: NextRequest): Promise<Response> {
  return createAmendmentSignHandler(getAuthService(), getAmendmentService())(request);
}

export const POST = withErrorHandling("amendment_sign", handlePost);
