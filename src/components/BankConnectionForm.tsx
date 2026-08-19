"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { accountNumbersMatch, isValidAccountNumber, isValidRoutingNumber } from "@/lib/finance/bankAccountValidation";

interface ActiveProfile {
  kind: "personal" | "business";
  personalProfileId?: string;
  businessProfileId?: string;
}

type Stage = "loading_identity" | "form" | "submitting" | "done" | "error";

/**
 * Phase 6A (docs/prsprints/PHASE_6A_PREPRODUCTION_FINANCIAL_UX_COMPLETION.md) Part 3: the production
 * bank-account connection experience, replacing the old sandbox-token entry field. Submits the raw
 * routing/account number exactly once, to the dedicated tokenize-and-connect endpoint
 * (POST /api/relationships/accounts/bank/connect) — this component never persists them anywhere
 * itself (no localStorage/sessionStorage, and React state for the raw values is cleared the moment the
 * request settles, success or failure) and the values are never included in the URL, a GET request, or
 * any client-side log.
 */
export function BankConnectionForm() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("loading_identity");
  const [party, setParty] = useState<{ kind: "personal" | "business"; id: string } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [institutionDisplayName, setInstitutionDisplayName] = useState("");
  const [accountHolderName, setAccountHolderName] = useState("");
  const [accountSubtype, setAccountSubtype] = useState<"checking" | "savings">("checking");
  const [routingNumber, setRoutingNumber] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountNumberConfirm, setAccountNumberConfirm] = useState("");

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

  const routingLooksValid = routingNumber.length === 0 || isValidRoutingNumber(routingNumber);
  const accountLooksValid = accountNumber.length === 0 || isValidAccountNumber(accountNumber);
  const confirmMatches = accountNumberConfirm.length === 0 || accountNumbersMatch(accountNumber, accountNumberConfirm);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!party || stage === "submitting") return;
    setStage("submitting");
    setErrorMessage(null);
    try {
      await apiFetch("/api/relationships/accounts/bank/connect", {
        method: "POST",
        body: JSON.stringify({
          actingParty: party,
          institutionDisplayName: institutionDisplayName || null,
          accountHolderName,
          routingNumber,
          accountNumber,
          accountNumberConfirm,
          accountSubtype,
        }),
      });
      setStage("done");
      // Clear the raw values from component state immediately — nothing left to linger in memory
      // once the request has resolved.
      setRoutingNumber("");
      setAccountNumber("");
      setAccountNumberConfirm("");
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

  const canSubmit =
    accountHolderName.trim().length > 0 &&
    isValidRoutingNumber(routingNumber) &&
    isValidAccountNumber(accountNumber) &&
    accountNumbersMatch(accountNumber, accountNumberConfirm);

  return (
    <form onSubmit={(event) => void handleSubmit(event)} style={{ display: "grid", gap: "1rem", maxWidth: "30rem" }}>
      <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.85rem" }}>
        Your account and routing numbers are used once to connect your bank and are never stored by
        PAY2PAY — only your bank&apos;s name and the last 4 digits of your account are kept on file.
      </p>

      <div className="field">
        <label htmlFor="bank-institution">Bank name</label>
        <input
          id="bank-institution"
          value={institutionDisplayName}
          onChange={(event) => setInstitutionDisplayName(event.target.value)}
          placeholder="e.g. First National Bank"
        />
      </div>

      <div className="field">
        <label htmlFor="bank-holder-name">Name on the account</label>
        <input
          id="bank-holder-name"
          required
          value={accountHolderName}
          onChange={(event) => setAccountHolderName(event.target.value)}
          autoComplete="name"
        />
      </div>

      <div className="field">
        <label htmlFor="bank-account-subtype">Account type</label>
        <select
          id="bank-account-subtype"
          value={accountSubtype}
          onChange={(event) => setAccountSubtype(event.target.value as "checking" | "savings")}
        >
          <option value="checking">Checking</option>
          <option value="savings">Savings</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="bank-routing">Routing number</label>
        <input
          id="bank-routing"
          inputMode="numeric"
          required
          maxLength={9}
          value={routingNumber}
          onChange={(event) => setRoutingNumber(event.target.value.replace(/\D/g, ""))}
          autoComplete="off"
        />
        {!routingLooksValid && (
          <small style={{ color: "var(--danger, #b3261e)" }}>That doesn&apos;t look like a valid routing number.</small>
        )}
      </div>

      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor="bank-account-number">Account number</label>
          <input
            id="bank-account-number"
            inputMode="numeric"
            required
            maxLength={17}
            value={accountNumber}
            onChange={(event) => setAccountNumber(event.target.value.replace(/\D/g, ""))}
            autoComplete="off"
          />
          {!accountLooksValid && <small style={{ color: "var(--danger, #b3261e)" }}>Enter 4-17 digits.</small>}
        </div>
        <div className="field">
          <label htmlFor="bank-account-number-confirm">Confirm account number</label>
          <input
            id="bank-account-number-confirm"
            inputMode="numeric"
            required
            maxLength={17}
            value={accountNumberConfirm}
            onChange={(event) => setAccountNumberConfirm(event.target.value.replace(/\D/g, ""))}
            autoComplete="off"
          />
          {!confirmMatches && <small style={{ color: "var(--danger, #b3261e)" }}>Account numbers don&apos;t match.</small>}
        </div>
      </div>

      {errorMessage && (
        <p className="field-error" role="alert">
          {errorMessage}
        </p>
      )}

      <button type="submit" className="button button--primary" disabled={stage === "submitting" || !canSubmit}>
        {stage === "submitting" ? "Connecting…" : "Connect bank account"}
      </button>
    </form>
  );
}
