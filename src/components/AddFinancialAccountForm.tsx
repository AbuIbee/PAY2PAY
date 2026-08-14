"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";

interface ActiveProfile {
  kind: "personal" | "business";
  personalProfileId?: string;
  businessProfileId?: string;
}

type Stage = "loading_identity" | "form" | "submitting" | "done" | "error";

/**
 * Sprint 9-12/18A: this sandbox has no real bank/card connect widget — the
 * sandbox provider boundary (Sprint 9's own scope) means the "tokenization"
 * step is this form collecting the same opaque reference a real
 * Plaid/processor-style connect flow would hand back, never a raw account
 * number/PAN/CVV. Both bank accounts and debit cards go through the same
 * Sprint 18A party-owned `financial_account` endpoint
 * (POST /api/relationships/accounts/add) — Sprint 11/12's own
 * `ach_mandate`/`debit_card_method` registration endpoints are
 * agreement-scoped, not usable here (see PaymentMethodsList's sibling
 * doc — this is the account you add to your wallet, before it's ever
 * assigned to any agreement).
 */
export function AddFinancialAccountForm({ accountType }: { accountType: "bank_account" | "debit_card" }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("loading_identity");
  const [party, setParty] = useState<{ kind: "personal" | "business"; id: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [institutionDisplayName, setInstitutionDisplayName] = useState("");
  const [providerAccountRef, setProviderAccountRef] = useState("");
  const [last4, setLast4] = useState("");
  const [cardBrand, setCardBrand] = useState("");
  const [expiryMonth, setExpiryMonth] = useState("");
  const [expiryYear, setExpiryYear] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const active = await apiFetch<ActiveProfile>("/api/profiles/active");
        const id = active.kind === "business" ? active.businessProfileId : active.personalProfileId;
        if (!id) throw new Error("no active identity");
        if (!cancelled) {
          setParty({ kind: active.kind, id });
          setStage("form");
        }
      } catch {
        if (!cancelled) setStage("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    // Guard synchronously (not just via the disabled DOM attribute, which
    // may not have re-rendered yet) — protects against a real double-click
    // firing two submits before React flushes the "submitting" state.
    if (!party || stage === "submitting") return;
    setStage("submitting");
    setErrorMessage(null);
    try {
      await apiFetch("/api/relationships/accounts/add", {
        method: "POST",
        body: JSON.stringify({
          actingParty: party,
          accountType,
          providerName: accountType === "bank_account" ? "sandbox-bank" : "sandbox-card-processor",
          providerAccountRef,
          maskedLast4: last4 || null,
          institutionDisplayName: accountType === "bank_account" ? institutionDisplayName || null : null,
          cardExpiryMonth: accountType === "debit_card" ? Number(expiryMonth) : null,
          cardExpiryYear: accountType === "debit_card" ? Number(expiryYear) : null,
          cardBrand: accountType === "debit_card" ? cardBrand || null : null,
        }),
      });
      setStage("done");
      // A new account starts pending_verification — a real provider webhook
      // would flip it later (Sprint 9's sandbox precedent); nothing further
      // to poll for here, so send the user straight to the list where its
      // status chip is authoritative.
      router.push("/payment-methods");
      router.refresh();
    } catch (error) {
      setStage("form");
      setErrorMessage(error instanceof Error ? error.message : "Something went wrong. Please try again.");
    }
  }

  if (stage === "loading_identity") return <p role="status">Loading…</p>;

  if (stage === "error" || !party) {
    return (
      <p className="form-status form-status--error" role="alert">
        We couldn&apos;t determine which account to add this to. Please try again.
      </p>
    );
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} style={{ display: "grid", gap: "1rem", maxWidth: "30rem" }}>
      {accountType === "bank_account" ? (
        <div className="field">
          <label htmlFor="institution">Bank name</label>
          <input
            id="institution"
            required
            value={institutionDisplayName}
            onChange={(event) => setInstitutionDisplayName(event.target.value)}
          />
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="card-brand">Card brand</label>
            <input id="card-brand" value={cardBrand} onChange={(event) => setCardBrand(event.target.value)} placeholder="Visa, Mastercard…" />
          </div>
          <div className="early-access-form__row">
            <div className="field">
              <label htmlFor="card-expiry-month">Expiry month</label>
              <input
                id="card-expiry-month"
                inputMode="numeric"
                required
                value={expiryMonth}
                onChange={(event) => setExpiryMonth(event.target.value.replace(/\D/g, ""))}
                placeholder="MM"
                maxLength={2}
              />
            </div>
            <div className="field">
              <label htmlFor="card-expiry-year">Expiry year</label>
              <input
                id="card-expiry-year"
                inputMode="numeric"
                required
                value={expiryYear}
                onChange={(event) => setExpiryYear(event.target.value.replace(/\D/g, ""))}
                placeholder="YYYY"
                maxLength={4}
              />
            </div>
          </div>
          <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.8rem" }}>
            If you use this card instead of a bank transfer for a payment, you may be charged the
            incremental processing cost over the standard ACH rate, unless your agreement states the
            other party covers processing fees.
          </p>
        </>
      )}

      <div className="field">
        <label htmlFor="last4">Last 4 digits</label>
        <input
          id="last4"
          inputMode="numeric"
          required
          maxLength={4}
          value={last4}
          onChange={(event) => setLast4(event.target.value.replace(/\D/g, ""))}
        />
      </div>

      <div className="field">
        <label htmlFor="provider-ref">
          {accountType === "bank_account" ? "Sandbox bank connection token" : "Sandbox card token"}
        </label>
        <input
          id="provider-ref"
          required
          value={providerAccountRef}
          onChange={(event) => setProviderAccountRef(event.target.value)}
        />
        <small>
          This sandbox has no live bank/card network connection — enter any non-empty test reference.
        </small>
      </div>

      {errorMessage && (
        <p className="field-error" role="alert">
          {errorMessage}
        </p>
      )}

      <button type="submit" className="button button--primary" disabled={stage === "submitting"}>
        {stage === "submitting" ? "Adding…" : accountType === "bank_account" ? "Add bank account" : "Add debit card"}
      </button>
    </form>
  );
}
