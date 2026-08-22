"use client";

import { useState } from "react";

const DISMISSED_KEY = "p2p_onboarding_dismissed";

/**
 * PRSprint 27 (docs/prsprints/PRSPRINT_27_DASHBOARDS_ONBOARDING_ROLE_AWARE_UX.md), master-spec items
 * 97-98: no first-use explanation existed anywhere in the product — a brand-new signup was dropped
 * straight onto `/dashboard` with zero context (SignupForm.tsx pushes directly to "/dashboard" or
 * `next`). This is intentionally a dismissible banner, not a blocking multi-step wizard, so it never
 * gets between a user and the app; dismissal is a client-only preference (no account-level concept of
 * "onboarding complete" exists yet, and a locally-dismissed banner is the honest scope for this
 * PRSprint — a full guided setup sequence is a larger, separate feature).
 *
 * Deliberately makes no claim about whether banking/cards are "live" vs "sandbox" for the *current*
 * environment: that signal is currently only computed for the admin-only environment status view
 * (AdminDashboard/AdminEnvironmentStatus, PRSprint 04/21/25's audit), with no non-admin endpoint to
 * read it from here — asserting a specific mode without that source of truth would risk exactly the
 * false "production-ready" claim master-spec item 177 forbids. Instead this points at the payment-
 * method/card setup screens themselves, which already show sandbox/live status at the point of use.
 */
export function OnboardingBanner({ kind }: { kind: "personal" | "business" }) {
  // This component only ever mounts client-side, after Dashboard's own data-fetch loading gate
  // resolves — it is never part of the server-rendered/hydrated tree — so reading localStorage
  // directly in the initializer (rather than via an effect + setState, which would cause a
  // cascading re-render) is safe; the `typeof window` guard is defensive only.
  const [dismissed, setDismissed] = useState(() => typeof window !== "undefined" && window.localStorage.getItem(DISMISSED_KEY) === "1");

  function dismiss() {
    window.localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  }

  if (dismissed) return null;

  return (
    <div className="card" role="note" aria-label="Welcome to PAY2PAY" style={{ display: "grid", gap: "0.6rem" }}>
      <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Welcome to PAY2PAY</h2>
      {kind === "personal" ? (
        <>
          <p style={{ margin: 0 }}>
            PAY2PAY helps two people track a repayment agreement — you might be <strong>making repayment</strong> (you owe
            money) or <strong>receiving repayment</strong> (you&apos;re owed money). Either way, the process is the same.
          </p>
          <p style={{ margin: 0 }}>
            Start by inviting the other person to connect. Once you both agree on terms and sign, that becomes the
            agreement you can both refer back to — it isn&apos;t final until both sides have signed.
          </p>
          <p style={{ margin: 0 }}>
            PAY2PAY tracks payments and balances for you, but it doesn&apos;t guarantee payment or act as a collector —
            it&apos;s a record-keeping and payment tool for an agreement you&apos;ve already made with someone you know.
            Bank and card setup will always show you clearly whether you&apos;re in sandbox or live mode before anything
            is created.
          </p>
        </>
      ) : (
        <>
          <p style={{ margin: 0 }}>
            Your business can send repayment agreements to customers, or receive them from vendors — the same tools
            work for either direction.
          </p>
          <p style={{ margin: 0 }}>
            Add staff under <strong>Organization → Staff</strong> so your team can help manage agreements and payments;
            each person&apos;s access is scoped to their role. Any financial account your business connects belongs to
            the business, not an individual employee.
          </p>
          <p style={{ margin: 0 }}>
            Bank and card setup will always show you clearly whether you&apos;re in sandbox or live mode before
            anything is created.
          </p>
        </>
      )}
      <div>
        <button type="button" className="button button--ghost" onClick={dismiss}>
          Got it
        </button>
      </div>
    </div>
  );
}
