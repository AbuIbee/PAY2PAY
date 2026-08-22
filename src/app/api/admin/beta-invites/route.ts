import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import type { BetaInviteService } from "@/lib/compliance/betaInviteService";
import { getBetaInviteService } from "@/lib/compliance/getBetaInviteService";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const generateSchema = z.object({
  code: z.string().trim().min(4).max(64),
  note: z.string().trim().max(500).optional(),
});

/** PRSprint 33 (docs/prsprints/PRSPRINT_33_FINAL_PRODUCTION_LAUNCH_CONTROLS_CLOSED_BETA.md): admin-managed closed-beta cohort. Authorization (isAdminRole) enforced inside BetaInviteService itself. */
export function createBetaInvitesListHandler(authService: AuthService, betaInviteService: BetaInviteService) {
  return async function handleList(request: NextRequest): Promise<Response> {
    const { platformRole } = await requireSession(request, authService);
    const codes = await betaInviteService.listCodes(platformRole);
    return NextResponse.json({ codes }, { status: 200 });
  };
}

export function createBetaInvitesGenerateHandler(authService: AuthService, betaInviteService: BetaInviteService) {
  return async function handleGenerate(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = generateSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError("A code (4-64 characters) is required.");
    }
    const record = await betaInviteService.generateCode({
      code: parsed.data.code,
      createdByUserId: userId,
      note: parsed.data.note ?? null,
      actingRole: platformRole,
    });
    return NextResponse.json({ code: record }, { status: 201 });
  };
}

async function handleList(request: NextRequest): Promise<Response> {
  return createBetaInvitesListHandler(getAuthService(), getBetaInviteService())(request);
}

async function handleGenerate(request: NextRequest): Promise<Response> {
  return createBetaInvitesGenerateHandler(getAuthService(), getBetaInviteService())(request);
}

export const GET = withErrorHandling("admin_beta_invites_list", handleList);
export const POST = withErrorHandling("admin_beta_invites_generate", handleGenerate);
