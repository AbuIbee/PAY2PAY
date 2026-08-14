import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { SupportCaseService } from "@/lib/admin/supportCaseService";
import { getSupportCaseService } from "@/lib/admin/getSupportCaseService";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const statusSchema = z.object({
  caseId: z.string().uuid(),
  status: z.enum(["open", "in_review", "resolved", "closed"]),
  resolutionNotes: z.string().trim().max(4000).nullable().optional(),
});

export function createSupportCaseStatusHandler(authService: AuthService, supportCaseService: SupportCaseService) {
  return async function handleStatus(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = statusSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "caseId and status are required.");
    }
    const supportCase = await supportCaseService.updateStatus({
      caseId: parsed.data.caseId,
      status: parsed.data.status,
      resolutionNotes: parsed.data.resolutionNotes,
      actingUserId: userId,
      actingRole: platformRole,
    });
    return NextResponse.json({ supportCase }, { status: 200 });
  };
}

async function handleStatus(request: NextRequest): Promise<Response> {
  return createSupportCaseStatusHandler(getAuthService(), getSupportCaseService())(request);
}

export const POST = withErrorHandling("support_case_status", handleStatus);
