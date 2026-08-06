import type { NextRequest, NextResponse } from "next/server";

export const SESSION_COOKIE_NAME = "p2p_session";

/**
 * Sets the session cookie httpOnly (never readable by client-side JS —
 * "don't leak session secrets to the client") and Secure outside local
 * development, so the raw session token is never exposed to page scripts or
 * sent over plaintext HTTP.
 */
export function setSessionCookie(response: NextResponse, token: string, expiresAt: Date): void {
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(0),
  });
}

export function getSessionToken(request: NextRequest): string | null {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}
