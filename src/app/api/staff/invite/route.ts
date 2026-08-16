import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { RateLimitedError, ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { getStaffService } from "@/lib/staff/getStaffService";
import type { StaffService } from "@/lib/staff/staffService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PRSprint 05 (docs/prsprints/PRSPRINT_05_DISTRIBUTED_RATE_LIMITING_ABUSE_CONTROLS.md): this route
// previously had no rate limiting — unbounded invitation creation is both a generic abuse vector
// (per-inviter) and a spam vector against the invited party specifically (per-target-email, since a
// single email could be re-invited repeatedly even by different inviting accounts/businesses).
const INVITE_LIMIT_PER_INVITER = 20;
const INVITE_LIMIT_PER_TARGET_EMAIL = 5;
const INVITE_WINDOW_MS = 60 * 60 * 1000;

const inviteSchema = z.object({
  businessProfileId: z.string().uuid(),
  email: z.string().trim().email(),
  role: z.enum(["owner", "manager", "receivables_staff", "accountant_viewer", "custom"]),
  customRoleId: z.string().uuid().optional(),
});

export function createStaffInviteHandler(authService: AuthService, staffService: StaffService) {
  return async function handleInvite(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = inviteSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "A valid invitation is required.");
    }

    if (!(await checkRateLimit(`staff-invite:inviter:${userId}`, INVITE_LIMIT_PER_INVITER, INVITE_WINDOW_MS))) {
      throw new RateLimitedError("Too many invitations sent. Please try again later.");
    }
    if (
      !(await checkRateLimit(
        `staff-invite:target:${parsed.data.email.toLowerCase()}`,
        INVITE_LIMIT_PER_TARGET_EMAIL,
        INVITE_WINDOW_MS,
      ))
    ) {
      throw new RateLimitedError("This person has already been invited too many times recently.");
    }

    const invitation = await staffService.inviteStaff({
      businessProfileId: parsed.data.businessProfileId,
      invitedByUserId: userId,
      email: parsed.data.email,
      role: parsed.data.role,
      customRoleId: parsed.data.customRoleId ?? null,
    });
    return NextResponse.json(
      { id: invitation.id, email: invitation.email, role: invitation.role, status: invitation.status, expiresAt: invitation.expiresAt },
      { status: 201 },
    );
  };
}

async function handleInvite(request: NextRequest): Promise<Response> {
  return createStaffInviteHandler(getAuthService(), getStaffService())(request);
}

export const POST = withErrorHandling("staff_invite", handleInvite);
