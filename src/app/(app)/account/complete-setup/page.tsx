import type { Metadata } from "next";
import { Suspense } from "react";
import { PersonalProfileForm } from "@/components/PersonalProfileForm";

export const metadata: Metadata = { title: "Complete your account" };

/**
 * Requirement #5/#6 (signup/onboarding redesign): a one-time completion flow for accounts that
 * predate the redesigned signup form and are missing required identity/contact/address information —
 * never a re-signup, never a rewrite of the existing account. Reuses PersonalProfileForm exactly (the
 * same fields, the same PUT /api/profiles/personal endpoint) rather than a second, parallel form.
 * OnboardingGate (mounted in the authenticated shell layout) is what routes an incomplete account here
 * after login; this page itself stays reachable directly at any time, and the shell's own nav (with
 * Log out and Support) is never hidden while it's shown, so this can never become a dead end.
 */
export default function CompleteAccountSetupPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>Complete your account</h1>
          <p className="app-page__lede">
            A few required details are missing from your account. This only takes a minute, and you won&apos;t be asked to do this
            again once it&apos;s complete.
          </p>
        </div>
      </div>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <PersonalProfileForm />
      </Suspense>
    </div>
  );
}
