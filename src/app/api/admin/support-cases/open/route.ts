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

const openSchema = z.object({
  subjectUserId: z.string().uuid(),
  category: z.string().trim().max(100).nullable().optional(),
  summary: z.string().trim().min(1).max(2000),
});

export function createSupportCaseOpenHandler(authService: AuthService, supportCaseService: SupportCaseService) {
  return async function handleOpen(request: NextRequest): Promise<Response> {
    const { userId, platformRole } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = openSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "subjectUserId and summary are required.");
    }
    const supportCase = await supportCaseService.openCase({
      subjectUserId: parsed.data.subjectUserId,
      category: parsed.data.category ?? null,
      summary: parsed.data.summary,
      actingUserId: userId,
      actingRole: platformRole,
    });
    return NextResponse.json({ supportCase }, { status: 201 });
  };
}

async function handleOpen(request: NextRequest): Promise<Response> {
  return createSupportCaseOpenHandler(getAuthService(), getSupportCaseService())(request);
}

export const POST = withErrorHandling("support_case_open", handleOpen);
