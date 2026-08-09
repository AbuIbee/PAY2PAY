"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

type Status = "idle" | "submitting" | "success" | "error";

export function SignupForm() {
  const formId = useId();
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);

    const data = new FormData(event.currentTarget);
    const payload = {
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
      dateOfBirth: String(data.get("dateOfBirth") ?? ""),
    };

    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        setStatus("success");
        router.push("/account");
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
    <form className="early-access-form" onSubmit={handleSubmit} noValidate style={{ maxWidth: "28rem" }}>
      <div className="field">
        <label htmlFor={`${formId}-email`}>Email</label>
        <input id={`${formId}-email`} name="email" type="email" autoComplete="email" required maxLength={254} />
      </div>
      <div className="field">
        <label htmlFor={`${formId}-password`}>Password</label>
        <input
          id={`${formId}-password`}
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={256}
        />
        <small>At least 8 characters.</small>
      </div>
      <div className="field">
        <label htmlFor={`${formId}-dob`}>Date of birth</label>
        <input id={`${formId}-dob`} name="dateOfBirth" type="date" required />
        <small>You must be at least 18 years old to create an account.</small>
      </div>

      {status === "error" && errorMessage ? (
        <p className="form-status form-status--error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button type="submit" className="button button--primary button--large" disabled={status === "submitting"}>
        {status === "submitting" ? "Creating account…" : "Create account"}
      </button>

      <p style={{ fontSize: "0.85rem", color: "var(--ink-soft)" }}>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </form>
  );
}
