"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SupportAppeals } from "./SupportAppeals";

type SessionState = "checking" | "authenticated" | "anonymous";

interface SupportCategory {
  title: string;
  description: string;
  /** Omitted when no truthful destination exists yet — see this file's own doc comment. */
  action?: { label: string; href: string };
}

const CATEGORIES: SupportCategory[] = [
  {
    title: "Account access",
    description: "Trouble signing in, resetting your password, or verifying your email.",
    action: { label: "Go to sign in", href: "/login" },
  },
  {
    title: "Payment arrangement questions",
    description: "Questions about an agreement you're a party to — terms, schedule, or status.",
    action: { label: "Sign in to view your agreements", href: "/login" },
  },
  {
    title: "Payment or transaction issue",
    description: "A payment that looks wrong, or something you want to raise about a transaction.",
    action: { label: "Sign in to view your payments", href: "/login" },
  },
  {
    title: "Identity verification",
    description: "Questions about verifying your identity or business.",
    action: { label: "Sign in to check verification status", href: "/login" },
  },
  {
    title: "Privacy or security concern",
    description:
      "If this relates to a decision on your account (a restriction, suspension, or dispute outcome), you can appeal it below once you sign in. A separate published privacy/security contact is not yet available.",
  },
  {
    title: "Accessibility assistance",
    description:
      "If you experienced a barrier using this site, and it relates to a decision on your account, you can note it in an appeal below once you sign in. A dedicated accessibility contact is not yet published.",
  },
];

/**
 * B0-A (public-surface remediation): the actual public landing for /support. Renders immediately and
 * unconditionally for any visitor — every category below routes only to real, already-existing
 * destinations (sign-in, or an honest statement that no dedicated channel exists yet for that topic).
 * This deliberately does NOT include a support email: the frozen B0 inventory found `support@
 * pay2pay.com` hardcoded in the old /support content, on the wrong (stale) domain, with no repository
 * evidence that any address at the correct `paid2you.com` domain is a real, monitored mailbox. Per
 * this pass's own special rule, an unverified address is never silently "corrected" to a guessed
 * `paid2you.com` equivalent — it is removed, and visitors are routed through the real, working support
 * mechanism that actually exists instead (sign in, then use the appeal flow below).
 *
 * The one authenticated feature this page fronts — appealing a decision (SupportAppeals) — is never
 * invoked merely by rendering this page: `/api/appeals` is only ever called once a lightweight session
 * check (the same technique AuthNavCta.tsx already uses site-wide, `GET /api/auth/me`) confirms an
 * active session. An anonymous visitor sees an explicit "sign in" prompt instead of a fetch failure.
 */
export function PublicSupport() {
  const [session, setSession] = useState<SessionState>("checking");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((response) => {
        if (!cancelled) setSession(response.ok ? "authenticated" : "anonymous");
      })
      .catch(() => {
        if (!cancelled) setSession("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <p style={{ margin: "0 0 1.5rem", color: "var(--ink-soft)", maxWidth: "40rem" }}>
        Most account, agreement, and payment questions are handled from inside your account. Pick the
        topic closest to what you need below.
      </p>

      <div style={{ display: "grid", gap: "1rem", marginBottom: "1.5rem" }}>
        {CATEGORIES.map((category) => (
          <div key={category.title} className="card">
            <div className="card__header">
              <h3 style={{ margin: 0 }}>{category.title}</h3>
            </div>
            <p style={{ margin: category.action ? "0 0 1rem" : 0, color: "var(--ink-soft)" }}>{category.description}</p>
            {category.action && (
              <Link className="button button--ghost" href={category.action.href}>
                {category.action.label}
              </Link>
            )}
          </div>
        ))}
      </div>

      {session === "authenticated" && <SupportAppeals />}

      {session === "anonymous" && (
        <div className="card">
          <div className="card__header">
            <h2>Appealing a decision</h2>
          </div>
          <p style={{ margin: 0, color: "var(--ink-soft)" }}>
            If you&apos;re appealing a specific decision made against your account (a restriction,
            suspension, or dispute outcome), <Link href="/login">sign in</Link> to submit and track it.
          </p>
        </div>
      )}
    </div>
  );
}
