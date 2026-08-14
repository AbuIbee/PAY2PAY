"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatMoney } from "@/lib/ui/money";
import type { ChipTone } from "@/lib/ui/statusLabels";

type VerificationState = "UNVERIFIED" | "BASIC" | "FULL_PENDING" | "FULL_VERIFIED" | "FULL_REJECTED";
type LoadState = "loading" | "ready" | "error";

interface PricingPlan {
  name: string;
  code: string;
  monthlyFeeMinorUnits: number | null;
  perAgreementFeeMinorUnits: number | null;
  perSuccessfulPaymentFeeMinorUnits: number | null;
  freeAgreementAllowance: number | null;
  freeIncludedPaymentsAllowance: number | null;
}

const VERIFICATION_LABEL: Record<VerificationState, { label: string; tone: ChipTone; description: string }> = {
  UNVERIFIED: { label: "Unverified", tone: "neutral", description: "Verify your email to reach basic verification." },
  BASIC: { label: "Basic", tone: "info", description: "Request full verification to unlock signing and payments." },
  FULL_PENDING: { label: "Full verification pending", tone: "warning", description: "Your verification request is being reviewed." },
  FULL_VERIFIED: { label: "Fully verified", tone: "success", description: "You can sign agreements and send/receive payments." },
  FULL_REJECTED: { label: "Verification rejected", tone: "danger", description: "Your last verification request was rejected. You can submit a new request." },
};

export function AccountVerification() {
  const [state, setState] = useState<LoadState>("loading");
  const [verification, setVerification] = useState<VerificationState | null>(null);
  const [profileKind, setProfileKind] = useState<"personal" | "business" | null>(null);
  const [plan, setPlan] = useState<PricingPlan | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [verificationBody, pricingBody] = await Promise.all([
        apiFetch<{ profileKind: "personal" | "business"; state: VerificationState }>("/api/profiles/verification"),
        apiFetch<{ plan: PricingPlan | null }>("/api/profiles/pricing"),
      ]);
      setVerification(verificationBody.state);
      setProfileKind(verificationBody.profileKind);
      setPlan(pricingBody.plan);
      setState("ready");
    } catch {
      setState("error");
    }
  }

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, []);

  async function handleRequestVerification() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await apiFetch("/api/profiles/verification", { method: "POST" });
      await refresh();
    } catch {
      setSubmitError("Couldn't submit your verification request. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "loading") {
    return (
      <div className="card" aria-hidden="true">
        <div className="skeleton skeleton--line" style={{ width: "40%" }} />
        <div className="skeleton skeleton--line" style={{ width: "70%" }} />
      </div>
    );
  }

  if (state === "error" || !verification) {
    return (
      <div className="form-status form-status--error" role="alert">
        Something went wrong loading your verification status. Please try again.
      </div>
    );
  }

  const info = VERIFICATION_LABEL[verification];

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <div className="card">
        <div className="card__header">
          <h2>{profileKind === "business" ? "Business verification" : "Identity verification"}</h2>
          <span className={`chip chip--${info.tone}`}>{info.label}</span>
        </div>
        <p style={{ color: "var(--ink-soft)" }}>{info.description}</p>
        {(verification === "BASIC" || verification === "FULL_REJECTED") && (
          <button type="button" className="button button--primary" onClick={() => void handleRequestVerification()} disabled={submitting}>
            {submitting ? "Submitting…" : "Request full verification"}
          </button>
        )}
        {submitError && <p className="field-error" role="alert" style={{ marginTop: "0.75rem" }}>{submitError}</p>}
      </div>

      <div className="card">
        <div className="card__header">
          <h2>Plan</h2>
        </div>
        {plan ? (
          <div style={{ display: "grid", gap: "0.4rem", color: "var(--ink-soft)" }}>
            <p style={{ margin: 0, color: "var(--ink)", fontWeight: 700 }}>{plan.name}</p>
            {plan.monthlyFeeMinorUnits !== null && <p style={{ margin: 0 }}>{formatMoney(plan.monthlyFeeMinorUnits)}/month</p>}
            {plan.perAgreementFeeMinorUnits !== null && <p style={{ margin: 0 }}>{formatMoney(plan.perAgreementFeeMinorUnits)} per agreement</p>}
            {plan.perSuccessfulPaymentFeeMinorUnits !== null && (
              <p style={{ margin: 0 }}>{formatMoney(plan.perSuccessfulPaymentFeeMinorUnits)} per successful payment</p>
            )}
            {plan.freeAgreementAllowance !== null && <p style={{ margin: 0 }}>{plan.freeAgreementAllowance} free agreements included</p>}
          </div>
        ) : (
          <div className="empty-state">
            <h3>No active plan</h3>
            <p>You&apos;re not currently subscribed to a pricing plan.</p>
          </div>
        )}
      </div>
    </div>
  );
}
