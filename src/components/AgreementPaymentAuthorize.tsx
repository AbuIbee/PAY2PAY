"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";

type Status = "idle" | "submitting" | "authorized" | "error";

/**
 * Restore agreement payment functionality: the one-click destination for Step 3/Step 5's "Set up
 * payment method" CTA when the debtor has already assigned a relationship funding account but hasn't
 * yet authorized *this specific agreement* to debit it. Deliberately thin — all it does is call
 * POST /api/agreements/payment-setup/authorize-mandate with the agreementId; the server resolves the
 * already-connected account and calls the existing AchMandateService.authorize itself, so this page
 * never sees or handles a raw bank account reference. On success, returns the user straight to the
 * agreement — its payment readiness recalculates automatically on the next progress read, with no
 * separate step required.
 */
export function AgreementPaymentAuthorize() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const agreementId = searchParams.get("id");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleAuthorize() {
    if (!agreementId) return;
    setStatus("submitting");
    setError(null);
    try {
      await apiFetch("/api/agreements/payment-setup/authorize-mandate", {
        method: "POST",
        body: JSON.stringify({ agreementId }),
      });
      setStatus("authorized");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not authorize payments for this agreement.");
      setStatus("error");
    }
  }

  if (!agreementId) {
    return (
      <p className="form-status form-status--error" role="alert">
        No agreement was specified.
      </p>
    );
  }

  if (status === "authorized") {
    return (
      <div className="empty-state">
        <h3>Payment method authorized</h3>
        <p>Your connected funding account is now authorized to make payments under this agreement.</p>
        <button
          type="button"
          className="button button--primary"
          onClick={() => router.push(`/agreements/detail?id=${agreementId}#make-payment`)}
        >
          Back to agreement
        </button>
      </div>
    );
  }

  return (
    <div className="card" style={{ maxWidth: "32rem" }}>
      <p>Authorize your connected funding account to make payments under this agreement.</p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog__actions" style={{ justifyContent: "flex-start", gap: "0.75rem" }}>
        <button type="button" className="button button--primary" onClick={() => void handleAuthorize()} disabled={status === "submitting"}>
          {status === "submitting" ? "Authorizing…" : "Authorize payment method"}
        </button>
        <a href={`/agreements/detail?id=${agreementId}`} className="button button--ghost">
          Cancel
        </a>
      </div>
    </div>
  );
}
