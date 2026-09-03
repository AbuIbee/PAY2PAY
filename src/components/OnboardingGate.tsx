"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";

interface CompletenessResult {
  ready: boolean;
  missingFields: string[];
}

/** Missing only these means "please verify your email" — not a structurally incomplete account. */
const STRUCTURAL_FIELDS = new Set(["firstName", "lastName", "contactPhone", "line1", "city", "state", "postalCode", "country"]);

/** Never redirected away from — this page itself, plus support/recovery, so the gate can never become a dead end. */
const EXEMPT_PATH_PREFIXES = ["/account/complete-setup", "/support"];

/**
 * Requirement #5/#6 (signup/onboarding redesign): routes an existing account that predates the
 * redesigned signup form — and is missing required identity/contact/address information — to the
 * one-time Complete Account Setup flow, without forcing a re-signup or touching the account itself.
 * Mounted once in the authenticated shell (src/app/(app)/layout.tsx), mirroring
 * AdminImpersonationBanner's own "silent client-side presence check" pattern — never blocks
 * rendering, never surfaces an error for a routine check, and never fires on an exempt path.
 *
 * Deliberately does NOT redirect when the only gap is an unverified preferred email
 * (missingFields === ["preferredEmail"]) — that is the ordinary, expected state of a brand-new
 * signup until they click the verification link already sent to them; sending them to a form with
 * nothing left to fill in would be confusing, not helpful.
 */
export function OnboardingGate() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (EXEMPT_PATH_PREFIXES.some((prefix) => pathname?.startsWith(prefix))) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await apiFetch<CompletenessResult>("/api/profiles/personal/completeness");
        if (cancelled || result.ready) return;
        const hasStructuralGap = result.missingFields.some((field) => STRUCTURAL_FIELDS.has(field));
        if (hasStructuralGap) {
          router.replace("/account/complete-setup?returnTo=/dashboard");
        }
      } catch {
        // Silent — this is a presence check, not a required page dependency; an unauthenticated
        // visitor or a transient failure just leaves normal page rendering unaffected.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  return null;
}
