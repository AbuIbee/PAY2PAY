import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import { getClientIp } from "@/lib/request-ip";
import type { WitnessService } from "@/lib/evidence/witnessService";
import { getWitnessService } from "@/lib/evidence/getWitnessService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const attestSchema = z.object({ agreementId: z.string().uuid() });

export function createWitnessAttestHandler(authService: AuthService, witnessService: WitnessService) {
  return async function handleAttest(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = attestSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("agreementId is required.");

    await witnessService.attest({
      agreementId: parsed.data.agreementId,
      actingUserId: userId,
      ipAddress: getClientIp(request),
      deviceInfo: null,
    });
    return NextResponse.json({ status: "attested" }, { status: 200 });
  };
}

async function handleAttest(request: NextRequest): Promise<Response> {
  return createWitnessAttestHandler(getAuthService(), getWitnessService())(request);
}

export const POST = withErrorHandling("witness_attest", handleAttest);
