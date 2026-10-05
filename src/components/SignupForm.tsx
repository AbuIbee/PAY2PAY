"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { BLANK_BUSINESS_DETAILS, BusinessDetailsFields, type BusinessDetailsState } from "./signup/BusinessDetailsFields";
import { BLANK_PERSONAL_IDENTITY, PersonalIdentityFields, type PersonalIdentityState } from "./signup/PersonalIdentityFields";
import { PasswordField } from "./PasswordField";
import { getSafeNextPath } from "@/lib/ui/safeRedirect";

type AccountType = "personal" | "business";
type Status = "idle" | "submitting" | "success" | "error";

function identityPayload(identity: PersonalIdentityState) {
  return {
    firstName: identity.firstName,
    middleName: identity.middleName || undefined,
    lastName: identity.lastName,
    contactPhone: identity.contactPhone,
    address: {
      line1: identity.address.line1,
      line2: identity.address.line2 || undefined,
      city: identity.address.city,
      state: identity.address.state,
      postalCode: identity.address.postalCode,
      country: identity.address.country,
    },
  };
}

function businessPayload(business: BusinessDetailsState) {
  return {
    legalBusinessName: business.legalBusinessName,
    dbaName: business.dbaName || undefined,
    entityType: business.entityType,
    businessPhone: business.businessPhone || undefined,
    businessAddress: {
      line1: business.businessAddress.line1,
      line2: business.businessAddress.line2 || undefined,
      city: business.businessAddress.city,
      postalCode: business.businessAddress.postalCode,
    },
    state: business.state,
    country: business.country,
    taxIdType: business.taxIdType,
  };
}

/**
 * Signup/onboarding redesign: account creation is now the normal place a new user establishes their
 * identity — not the profile page (see AccountProvisioningRepository's doc comment in authService.ts
 * for the production defect this closes). Account type (Personal/Business) is the first question;
 * the rest of the form is conditional on it. The profile page (PersonalProfileForm) remains available
 * afterward for reviewing/updating this same information — it is no longer the first place it's set.
 */
export function SignupForm() {
  const formId = useId();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [accountType, setAccountType] = useState<AccountType>("personal");
  const [email, setEmail] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [identity, setIdentity] = useState<PersonalIdentityState>(BLANK_PERSONAL_IDENTITY);
  const [business, setBusiness] = useState<BusinessDetailsState>(BLANK_BUSINESS_DETAILS);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);

    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") ?? "");

    const payload =
      accountType === "personal"
        ? { accountType, email, password, dateOfBirth, identity: identityPayload(identity) }
        : { accountType, email, password, dateOfBirth, identity: identityPayload(identity), business: businessPayload(business) };

    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        setStatus("success");
        router.push(getSafeNextPath(searchParams.get("next"), "/dashboard"));
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setStatus("error");
      setErrorMessage(body?.message ?? "Something went wrong. Please try again.");
    } catch {
      setStatus("error");
      setErrorMessage("Something went wrong. Please check your connection and try again.");
    }
  }

  return (
    <form className="early-access-form" onSubmit={handleSubmit} noValidate style={{ maxWidth: "34rem" }}>
      <div className="field">
        <span style={{ display: "block", marginBottom: "0.4rem" }}>
          Account type <span aria-hidden="true" style={{ color: "var(--ink-soft)" }}>*</span>
        </span>
        <div role="radiogroup" aria-label="Account type" style={{ display: "flex", gap: "1.5rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
            <input
              type="radio"
              name="accountType"
              value="personal"
              checked={accountType === "personal"}
              onChange={() => setAccountType("personal")}
            />
            Personal
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
            <input
              type="radio"
              name="accountType"
              value="business"
              checked={accountType === "business"}
              onChange={() => setAccountType("business")}
            />
            Business
          </label>
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${formId}-email`}>Email</label>
        <input
          id={`${formId}-email`}
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <small>This becomes your sign-in email and your preferred contact email — you won&apos;t need to type it twice.</small>
      </div>
      <PasswordField
        id={`${formId}-password`}
        name="password"
        label="Password"
        autoComplete="new-password"
        required
        minLength={8}
        maxLength={256}
        helperText="At least 8 characters."
      />
      <div className="field">
        <label htmlFor={`${formId}-dob`}>Date of birth</label>
        <input
          id={`${formId}-dob`}
          name="dateOfBirth"
          type="date"
          required
          value={dateOfBirth}
          onChange={(event) => setDateOfBirth(event.target.value)}
        />
        <small>You must be at least 18 years old to create an account.</small>
      </div>

      <PersonalIdentityFields
        value={identity}
        onChange={setIdentity}
        legend={accountType === "business" ? "Authorized representative" : undefined}
      />

      {accountType === "business" ? <BusinessDetailsFields value={business} onChange={setBusiness} /> : null}

      {status === "error" && errorMessage ? (
        <p className="form-status form-status--error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button type="submit" className="button button--primary button--large" disabled={status === "submitting"}>
        {status === "submitting" ? "Creating account…" : "Create account"}
      </button>

      <p style={{ fontSize: "0.85rem", color: "var(--ink-soft)" }}>
        Already have an account?{" "}
        <Link href={searchParams.get("next") ? `/login?next=${encodeURIComponent(searchParams.get("next")!)}` : "/login"}>
          Sign in
        </Link>
      </p>
    </form>
  );
}
