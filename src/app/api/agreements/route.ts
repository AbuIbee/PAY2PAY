import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AgreementService } from "@/lib/agreements/agreementService";
import { createAgreementSchema } from "@/lib/agreements/validation";
import { getAgreementService } from "@/lib/agreements/getAgreementService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function createAgreementCreateHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleCreate(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = createAgreementSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid agreement draft is required.");
    }

    const result = await agreementService.createDraft({ creatorUserId: userId, ...parsed.data });
    return NextResponse.json(
      {
        id: result.agreement.id,
        status: result.agreement.status,
        relationshipShape: agreementService.relationshipShape(result.agreement),
        version: {
          id: result.version.id,
          versionNumber: result.version.versionNumber,
          terms: result.version.terms,
        },
        schedule: result.schedule,
      },
      { status: 201 },
    );
  };
}

const listQuerySchema = z.object({
  profileKind: z.enum(["personal", "business"]),
  profileId: z.string().uuid(),
});

export function createAgreementListHandler(authService: AuthService, agreementService: AgreementService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const url = new URL(request.url);
    const parsed = listQuerySchema.safeParse({
      profileKind: url.searchParams.get("profileKind"),
      profileId: url.searchParams.get("profileId"),
    });
    if (!parsed.success) throw new ValidationError("profileKind and profileId are required.");

    const agreements = await agreementService.listAgreements(userId, {
      kind: parsed.data.profileKind,
      id: parsed.data.profileId,
    });
    return NextResponse.json(
      {
        agreements: agreements.map((a) => ({
          id: a.id,
          status: a.status,
          currency: a.currency,
          relationshipShape: agreementService.relationshipShape(a),
          createdAt: a.createdAt,
        })),
      },
      { status: 200 },
    );
  };
}

async function handleCreate(request: NextRequest): Promise<Response> {
  return createAgreementCreateHandler(getAuthService(), getAgreementService())(request);
}

async function handleList(request: NextRequest): Promise<Response> {
  return createAgreementListHandler(getAuthService(), getAgreementService())(request);
}

export const POST = withErrorHandling("agreement_create", handleCreate);
export const GET = withErrorHandling("agreement_list", handleList);
