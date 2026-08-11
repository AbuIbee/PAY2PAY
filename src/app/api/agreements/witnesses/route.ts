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

const addSchema = z.object({ agreementId: z.string().uuid(), witnessUserId: z.string().uuid() });

export function createWitnessAddHandler(authService: AuthService, witnessService: WitnessService) {
  return async function handleAdd(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = addSchema.safeParse(rawBody);
    if (!parsed.success) throw new ValidationError("agreementId and witnessUserId are required.");

    const record = await witnessService.addWitness({
      agreementId: parsed.data.agreementId,
      actingUserId: userId,
      witnessUserId: parsed.data.witnessUserId,
      ipAddress: getClientIp(request),
      deviceInfo: null,
    });
    return NextResponse.json({ id: record.id, witnessUserId: record.witnessUserId }, { status: 201 });
  };
}

export function createWitnessListHandler(authService: AuthService, witnessService: WitnessService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const agreementId = new URL(request.url).searchParams.get("agreementId");
    if (!agreementId) throw new ValidationError("agreementId is required.");

    const witnesses = await witnessService.listWitnesses(agreementId, userId);
    return NextResponse.json(
      {
        witnesses: witnesses.map((w) => ({
          id: w.id,
          witnessUserId: w.witnessUserId,
          addedAt: w.addedAt,
          attestedAt: w.attestedAt,
        })),
      },
      { status: 200 },
    );
  };
}

async function handleAdd(request: NextRequest): Promise<Response> {
  return createWitnessAddHandler(getAuthService(), getWitnessService())(request);
}

async function handleList(request: NextRequest): Promise<Response> {
  return createWitnessListHandler(getAuthService(), getWitnessService())(request);
}

export const POST = withErrorHandling("witness_add", handleAdd);
export const GET = withErrorHandling("witness_list", handleList);
