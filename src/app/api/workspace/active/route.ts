import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api-handler";
import type { AuthService } from "@/lib/auth/authService";
import { getAuthService } from "@/lib/auth/getAuthService";
import { requireSession } from "@/lib/auth/requireSession";
import { ValidationError } from "@/lib/errors";
import type { BusinessActivationService } from "@/lib/organizations/businessActivationService";
import { getBusinessActivationService } from "@/lib/organizations/getBusinessActivationService";
import { getWorkspaceContextService } from "@/lib/organizations/getWorkspaceContextService";
import type { WorkspaceContext, WorkspaceContextService } from "@/lib/organizations/workspaceContext";
import { getWorkspaceSelectorFromCookie, setWorkspaceCookie } from "@/lib/organizations/workspaceCookie";
import type { BusinessProfileRepository } from "@/lib/profiles/businessProfileService";
import { DrizzleBusinessProfileRepository } from "@/lib/profiles/drizzleBusinessProfileRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const selectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal") }),
  z.object({ kind: z.literal("organization"), organizationId: z.string().uuid() }),
]);

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 7/8: the organization workspace SHELL's own
 * single read — membership-validated context PLUS enough display/activation info to render the
 * shell and an honest activation banner, without a second owner-gated call (BusinessOnboardingService.
 * getOnboardingState is deliberately owner-only; any active member, any role, may view their own
 * workspace's activation state).
 */
async function enrichContext(
  context: WorkspaceContext,
  businessProfiles: BusinessProfileRepository,
  activation: BusinessActivationService,
): Promise<Record<string, unknown>> {
  if (context.kind === "personal") return context;
  const [profile, status] = await Promise.all([businessProfiles.findById(context.organizationId), activation.computeActivationStatus(context.organizationId)]);
  return { ...context, displayName: profile?.displayName ?? null, activation: status };
}

export function createWorkspaceActiveGetHandler(
  authService: AuthService,
  workspaceContext: WorkspaceContextService,
  businessProfiles: BusinessProfileRepository,
  activation: BusinessActivationService,
) {
  return async function handleGet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const cookieSelector = getWorkspaceSelectorFromCookie(request);
    const resolved = await workspaceContext.resolveWorkspaceContext(userId, cookieSelector ?? { kind: "personal" });
    return NextResponse.json(await enrichContext(resolved, businessProfiles, activation), { status: 200 });
  };
}

export function createWorkspaceActiveSetHandler(
  authService: AuthService,
  workspaceContext: WorkspaceContextService,
  businessProfiles: BusinessProfileRepository,
  activation: BusinessActivationService,
) {
  return async function handleSet(request: NextRequest): Promise<Response> {
    const { userId } = await requireSession(request, authService);
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = selectorSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ValidationError("A valid workspace selection is required.");
    }
    // Ownership/membership re-verified here — never trusts the browser-supplied organizationId directly.
    const resolved = await workspaceContext.resolveWorkspaceContext(userId, parsed.data);
    const response = NextResponse.json(await enrichContext(resolved, businessProfiles, activation), { status: 200 });
    setWorkspaceCookie(response, parsed.data);
    return response;
  };
}

async function handleGet(request: NextRequest): Promise<Response> {
  return createWorkspaceActiveGetHandler(getAuthService(), getWorkspaceContextService(), new DrizzleBusinessProfileRepository(), getBusinessActivationService())(request);
}

async function handleSet(request: NextRequest): Promise<Response> {
  return createWorkspaceActiveSetHandler(getAuthService(), getWorkspaceContextService(), new DrizzleBusinessProfileRepository(), getBusinessActivationService())(request);
}

export const GET = withErrorHandling("workspace_active_get", handleGet);
export const POST = withErrorHandling("workspace_active_set", handleSet);
