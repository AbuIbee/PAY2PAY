import type { NextRequest, NextResponse } from "next/server";
import type { WorkspaceSelector } from "./workspaceContext";

export const WORKSPACE_COOKIE_NAME = "p2p_workspace";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 7: mirrors activeProfileCookie.ts's own
 * established contract exactly — a convenience hint only, never a trust boundary. Every read of it
 * is re-verified through WorkspaceContextService.resolveWorkspaceContext (membership + organization
 * status) before use; a tampered, stale, or cross-tenant cookie can never grant access it shouldn't.
 */
export function setWorkspaceCookie(response: NextResponse, selector: WorkspaceSelector): void {
  response.cookies.set(WORKSPACE_COOKIE_NAME, JSON.stringify(selector), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

interface RawSelector {
  kind?: unknown;
  organizationId?: unknown;
}

export function getWorkspaceSelectorFromCookie(request: NextRequest): WorkspaceSelector | null {
  const raw = request.cookies.get(WORKSPACE_COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RawSelector;
    if (parsed.kind === "personal") return { kind: "personal" };
    if (parsed.kind === "organization" && typeof parsed.organizationId === "string") {
      return { kind: "organization", organizationId: parsed.organizationId };
    }
    return null;
  } catch {
    return null;
  }
}
