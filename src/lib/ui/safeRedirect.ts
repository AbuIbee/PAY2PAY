/**
 * Sprint 18B: login/signup accept a `?next=` param so the cooperative
 * handshake's "invite -> signup/login -> verification -> invitation resumed
 * -> explicit acceptance" flow can survive an auth detour (Sprint 18A's own
 * required flow — flagged as missing by the Connections fork). Only a
 * same-origin relative path is ever honored, to avoid turning this into an
 * open-redirect vector via a crafted `next` value (e.g. `//evil.example` or
 * `https://evil.example`).
 */
export function getSafeNextPath(next: string | null, fallback: string): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  return next;
}
