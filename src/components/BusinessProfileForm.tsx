"use client";

import { useId, useState, type FormEvent } from "react";
import { US_STATE_CODES } from "@/lib/us-states";

type Status = "idle" | "submitting" | "error";

export function BusinessProfileForm({ onCreated }: { onCreated: () => void }) {
  const formId = useId();
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);
    const data = new FormData(event.currentTarget);
    const payload = {
      legalBusinessName: String(data.get("legalBusinessName") ?? ""),
      displayName: String(data.get("displayName") ?? ""),
      entityType: String(data.get("entityType") ?? ""),
      businessAddress: {
        line1: String(data.get("line1") ?? ""),
        city: String(data.get("city") ?? ""),
        state: String(data.get("state") ?? ""),
        postalCode: String(data.get("postalCode") ?? ""),
      },
      country: "US",
      state: String(data.get("state") ?? ""),
    };

    try {
      const response = await fetch("/api/profiles/business", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        setStatus("idle");
        setOpen(false);
        event.currentTarget.reset();
        onCreated();
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setStatus("error");
      setErrorMessage(body?.message ?? "Could not create business profile.");
    } catch {
      setStatus("error");
      setErrorMessage("Something went wrong. Please check your connection and try again.");
    }
  }

  if (!open) {
    return (
      <button type="button" className="button button--ghost" onClick={() => setOpen(true)}>
        + Add a business
      </button>
    );
  }

  return (
    <form className="early-access-form" onSubmit={handleSubmit} noValidate style={{ maxWidth: "28rem" }}>
      <div className="field">
        <label htmlFor={`${formId}-legal`}>Legal business name</label>
        <input id={`${formId}-legal`} name="legalBusinessName" type="text" required maxLength={200} />
      </div>
      <div className="field">
        <label htmlFor={`${formId}-display`}>Display name</label>
        <input id={`${formId}-display`} name="displayName" type="text" required maxLength={200} />
      </div>
      <div className="field">
        <label htmlFor={`${formId}-entity`}>Entity type</label>
        <input id={`${formId}-entity`} name="entityType" type="text" required maxLength={100} placeholder="e.g. LLC, sole proprietorship" />
      </div>
      <div className="field">
        <label htmlFor={`${formId}-line1`}>Business address</label>
        <input id={`${formId}-line1`} name="line1" type="text" required placeholder="Street address" />
      </div>
      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor={`${formId}-city`}>City</label>
          <input id={`${formId}-city`} name="city" type="text" required />
        </div>
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
      </div>
      <div className="field">
        <label htmlFor={`${formId}-postal`}>Postal code</label>
        <input id={`${formId}-postal`} name="postalCode" type="text" required maxLength={10} />
      </div>

      {status === "error" && errorMessage ? (
        <p className="form-status form-status--error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <div className="hero__actions">
        <button type="submit" className="button button--primary" disabled={status === "submitting"}>
          {status === "submitting" ? "Creating…" : "Create business profile"}
        </button>
        <button type="button" className="button button--ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
