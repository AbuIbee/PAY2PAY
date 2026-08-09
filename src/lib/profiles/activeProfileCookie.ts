import type { NextRequest, NextResponse } from "next/server";
import type { ActiveProfileSelector } from "./profileAccessService";

export const ACTIVE_PROFILE_COOKIE_NAME = "p2p_active_profile";

/**
 * The cookie is a convenience hint only, never a trust boundary — every
 * read of it is re-verified through ProfileAccessService.resolveActiveProfile
 * (ownership + active-status checks) before use, so a tampered or stale
 * cookie (e.g. a business that was disabled after the cookie was set) can
 * never grant access it shouldn't.
 */
export function setActiveProfileCookie(response: NextResponse, selector: ActiveProfileSelector): void {
  response.cookies.set(ACTIVE_PROFILE_COOKIE_NAME, JSON.stringify(selector), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

interface RawSelector {
  kind?: unknown;
  businessProfileId?: unknown;
}

export function getActiveProfileSelectorFromCookie(request: NextRequest): ActiveProfileSelector | null {
  const raw = request.cookies.get(ACTIVE_PROFILE_COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RawSelector;
    if (parsed.kind === "personal") {
      return { kind: "personal" };
    }
    if (parsed.kind === "business" && typeof parsed.businessProfileId === "string") {
      return { kind: "business", businessProfileId: parsed.businessProfileId };
    }
    return null;
  } catch {
    return null;
  }
}
