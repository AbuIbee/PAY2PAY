"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { US_STATE_CODES } from "@/lib/us-states";

type SubmitStatus = "idle" | "submitting" | "success" | "error";

const INITIAL_ACCOUNT_TYPE: "individual" | "business" = "individual";

export function EarlyAccessForm() {
  const formId = useId();
  const [accountType, setAccountType] = useState<"individual" | "business">(
    INITIAL_ACCOUNT_TYPE,
  );
  const [status, setStatus] = useState<SubmitStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);

    const form = event.currentTarget;
    const data = new FormData(form);

    // Honeypot: real visitors never populate this field (it's visually
    // hidden and out of tab order below). If it's filled, still submit so
    // an automated filler doesn't learn its behavior differs — the server
    // silently no-ops on a non-empty honeypot value.
    const payload = {
      name: String(data.get("name") ?? ""),
      email: String(data.get("email") ?? ""),
      accountType,
      businessName: accountType === "business" ? String(data.get("businessName") ?? "") : undefined,
      state: String(data.get("state") ?? ""),
      intendedUse: String(data.get("intendedUse") ?? ""),
      expectedAgreementsPerMonth: Number(data.get("expectedAgreementsPerMonth") ?? 0),
      notes: String(data.get("notes") ?? "") || undefined,
      website: String(data.get("website") ?? ""),
    };

    try {
      const response = await fetch("/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        setStatus("success");
        form.reset();
        setAccountType(INITIAL_ACCOUNT_TYPE);
        return;
      }

      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setStatus("error");
      setErrorMessage(
        response.status === 429
          ? "Too many submissions from this connection. Please try again later."
          : body?.message ?? "Something went wrong. Please try again.",
      );
    } catch {
      setStatus("error");
      setErrorMessage("Something went wrong. Please check your connection and try again.");
    }
  }

  if (status === "success") {
    return (
      <div className="early-access-form" role="status">
        <p className="form-status form-status--success">
          Thanks — you&apos;re on the early-access list. We&apos;ll be in touch as new capabilities
          become available.
        </p>
      </div>
    );
  }

  return (
    <form className="early-access-form" onSubmit={handleSubmit} noValidate>
      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor={`${formId}-name`}>Name</label>
          <input id={`${formId}-name`} name="name" type="text" autoComplete="name" required maxLength={200} />
        </div>
        <div className="field">
          <label htmlFor={`${formId}-email`}>Email</label>
          <input id={`${formId}-email`} name="email" type="email" autoComplete="email" required maxLength={254} />
        </div>
      </div>

      <div className="field">
        <span id={`${formId}-account-type-label`} style={{ fontSize: "0.8rem", fontWeight: 700 }}>
          Account type
        </span>
        <div className="early-access-form__row" role="radiogroup" aria-labelledby={`${formId}-account-type-label`}>
          <div className="checkbox-field">
            <input
              id={`${formId}-account-individual`}
              type="radio"
              name="accountTypeChoice"
              checked={accountType === "individual"}
              onChange={() => setAccountType("individual")}
            />
            <label htmlFor={`${formId}-account-individual`}>Individual</label>
          </div>
          <div className="checkbox-field">
            <input
              id={`${formId}-account-business`}
              type="radio"
              name="accountTypeChoice"
              checked={accountType === "business"}
              onChange={() => setAccountType("business")}
            />
            <label htmlFor={`${formId}-account-business`}>Business</label>
          </div>
        </div>
      </div>

      {accountType === "business" ? (
        <div className="field">
          <label htmlFor={`${formId}-business-name`}>Business name</label>
          <input
            id={`${formId}-business-name`}
            name="businessName"
            type="text"
            required
            maxLength={200}
          />
        </div>
      ) : null}

      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor={`${formId}-state`}>State</label>
          <select id={`${formId}-state`} name="state" required defaultValue="">
            <option value="" disabled>
              Select a state
            </option>
            {US_STATE_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${formId}-agreements`}>Approx. agreements per month</label>
          <input
            id={`${formId}-agreements`}
            name="expectedAgreementsPerMonth"
            type="number"
            inputMode="numeric"
            min={0}
            max={1000000}
            required
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${formId}-intended-use`}>Intended use</label>
        <input
          id={`${formId}-intended-use`}
          name="intendedUse"
          type="text"
          required
          maxLength={1000}
          placeholder="e.g. Repayment plans for completed repair jobs"
        />
      </div>

      <div className="field">
        <label htmlFor={`${formId}-notes`}>Notes (optional)</label>
        <textarea id={`${formId}-notes`} name="notes" maxLength={2000} />
      </div>

      <div className="checkbox-field">
        <input id={`${formId}-consent`} type="checkbox" required />
        <label htmlFor={`${formId}-consent`}>
          I agree to be contacted about PAY2PAY early access. Our{" "}
          <Link href="/privacy">privacy</Link> and <Link href="/terms">terms</Link> pages are
          still being finalized.
        </label>
      </div>

      {/* Honeypot field — real users never see or fill this. */}
      <div className="field field--honeypot" aria-hidden="true">
        <label htmlFor={`${formId}-website`}>Website</label>
        <input id={`${formId}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {status === "error" && errorMessage ? (
        <p className="form-status form-status--error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button
        type="submit"
        className="button button--primary button--large"
        disabled={status === "submitting"}
      >
        {status === "submitting" ? "Submitting…" : "Request early access"}
      </button>
    </form>
  );
}
