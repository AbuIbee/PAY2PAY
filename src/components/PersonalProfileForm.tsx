"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";

interface ProfileAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

interface ProfileResponse {
  firstName: string | null;
  lastName: string | null;
  preferredEmail: string | null;
  preferredEmailVerified: boolean;
  contactPhone: string | null;
  address: ProfileAddress | null;
}

interface FormState {
  firstName: string;
  lastName: string;
  preferredEmail: string;
  contactPhone: string;
  address: ProfileAddress;
}

/** Visibly marks a required field's label — every field this form collects is required except address line 2 (Blocker 1: "the profile form must clearly indicate required fields"). */
function Req() {
  return (
    <span aria-hidden="true" style={{ color: "var(--ink-soft)" }}>
      {" "}
      *
    </span>
  );
}

const BLANK: FormState = {
  firstName: "",
  lastName: "",
  preferredEmail: "",
  contactPhone: "",
  address: { line1: "", line2: "", city: "", state: "", postalCode: "", country: "US" },
};

type LoadStatus = "loading" | "ready" | "error";

/**
 * Decision 5: Account -> Personal Information / Contact Information. Every field this form collects
 * (First/Last name, Contact phone, Preferred email, Address line 1/2, City, State, ZIP, Country) is
 * personal information — never described as non-PII (Decision 10).
 */
export function PersonalProfileForm() {
  const router = useRouter();
  const returnTo = useSearchParams().get("returnTo");
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [initialVerified, setInitialVerified] = useState(false);
  const [initialEmail, setInitialEmail] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(BLANK);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [verifiedNow, setVerifiedNow] = useState(false);
  const [resendStatus, setResendStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<ProfileResponse>("/api/profiles/personal");
        if (cancelled) return;
        setForm({
          firstName: body.firstName ?? "",
          lastName: body.lastName ?? "",
          preferredEmail: body.preferredEmail ?? "",
          contactPhone: body.contactPhone ?? "",
          address: body.address ?? BLANK.address,
        });
        setInitialVerified(body.preferredEmailVerified);
        setInitialEmail(body.preferredEmail);
        setVerifiedNow(body.preferredEmailVerified);
        setLoadStatus("ready");
      } catch {
        if (!cancelled) setLoadStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setAddressField<K extends keyof ProfileAddress>(key: K, value: ProfileAddress[K]) {
    setForm((prev) => ({ ...prev, address: { ...prev.address, [key]: value } }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaveStatus("saving");
    setError(null);
    try {
      const body = await apiFetch<ProfileResponse>("/api/profiles/personal", {
        method: "PUT",
        body: JSON.stringify(form),
      });
      setInitialVerified(body.preferredEmailVerified);
      setInitialEmail(body.preferredEmail);
      setVerifiedNow(body.preferredEmailVerified);
      setSaveStatus("saved");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save your profile. Please try again.");
      setSaveStatus("error");
    }
  }

  async function handleResend() {
    setResendStatus("sending");
    try {
      await apiFetch("/api/profiles/personal/resend-verification", { method: "POST" });
      setResendStatus("sent");
    } catch {
      setResendStatus("error");
    }
  }

  if (loadStatus === "loading") {
    return (
      <div className="card" aria-hidden="true">
        <div className="skeleton skeleton--line" style={{ width: "40%" }} />
        <div className="skeleton skeleton--line" style={{ width: "70%" }} />
      </div>
    );
  }

  if (loadStatus === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong loading your profile. Please try again.
      </p>
    );
  }

  const emailChangedSinceLoad = form.preferredEmail.trim().toLowerCase() !== (initialEmail ?? "").trim().toLowerCase();
  const showsUnverifiedNotice = saveStatus === "saved" ? !verifiedNow : !initialVerified && !!form.preferredEmail;

  return (
    <form className="card" onSubmit={(event) => void handleSubmit(event)} style={{ display: "grid", gap: "1rem", maxWidth: "34rem" }}>
      <div className="card__header">
        <h3>Personal information</h3>
      </div>
      <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--ink-soft)" }}>
        Fields marked <Req /> are required to accept or sign an agreement. Address line 2 is the only optional field.
      </p>

      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor="profile-first-name">
            First name
            <Req />
          </label>
          <input id="profile-first-name" value={form.firstName} onChange={(event) => setField("firstName", event.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="profile-last-name">
            Last name
            <Req />
          </label>
          <input id="profile-last-name" value={form.lastName} onChange={(event) => setField("lastName", event.target.value)} required />
        </div>
      </div>

      <div className="field">
        <label htmlFor="profile-preferred-email">
          Preferred email
          <Req />
        </label>
        <input
          id="profile-preferred-email"
          type="email"
          value={form.preferredEmail}
          onChange={(event) => setField("preferredEmail", event.target.value)}
          required
        />
        <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "var(--ink-soft)" }}>
          Shown on your agreements and used for agreement-related contact. Your sign-in email is never changed by this field. Must be
          verified before it counts toward agreement readiness.
        </p>
        {showsUnverifiedNotice && !emailChangedSinceLoad && (
          <p className="form-status" style={{ marginTop: "0.4rem" }}>
            Not yet verified.{" "}
            <button type="button" className="button button--ghost" onClick={() => void handleResend()} disabled={resendStatus === "sending"}>
              {resendStatus === "sent" ? "Verification email sent" : resendStatus === "sending" ? "Sending…" : "Resend verification email"}
            </button>
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor="profile-contact-phone">
          Contact phone
          <Req />
        </label>
        <input id="profile-contact-phone" value={form.contactPhone} onChange={(event) => setField("contactPhone", event.target.value)} required />
      </div>

      <div className="field">
        <label htmlFor="profile-address-line1">
          Address line 1
          <Req />
        </label>
        <input id="profile-address-line1" value={form.address.line1} onChange={(event) => setAddressField("line1", event.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="profile-address-line2">Address line 2 (optional)</label>
        <input id="profile-address-line2" value={form.address.line2} onChange={(event) => setAddressField("line2", event.target.value)} />
      </div>
      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor="profile-city">
            City
            <Req />
          </label>
          <input id="profile-city" value={form.address.city} onChange={(event) => setAddressField("city", event.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="profile-state">
            State/province
            <Req />
          </label>
          <input id="profile-state" value={form.address.state} onChange={(event) => setAddressField("state", event.target.value)} required />
        </div>
      </div>
      <div className="early-access-form__row">
        <div className="field">
          <label htmlFor="profile-postal-code">
            ZIP/postal code
            <Req />
          </label>
          <input id="profile-postal-code" value={form.address.postalCode} onChange={(event) => setAddressField("postalCode", event.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="profile-country">
            Country
            <Req />
          </label>
          <input id="profile-country" value={form.address.country} onChange={(event) => setAddressField("country", event.target.value)} required />
        </div>
      </div>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {saveStatus === "saved" && (
        <p className="form-status form-status--success" role="status">
          Profile saved.
          {emailChangedSinceLoad || !verifiedNow
            ? " Check your inbox to confirm your new preferred email before it appears on any agreement."
            : ""}
        </p>
      )}

      <div className="hero__actions">
        <button type="submit" className="button button--primary" disabled={saveStatus === "saving"}>
          {saveStatus === "saving" ? "Saving…" : "Save profile"}
        </button>
        {returnTo && (
          <button type="button" className="button button--ghost" onClick={() => router.push(returnTo)}>
            Return to agreement
          </button>
        )}
      </div>
    </form>
  );
}
