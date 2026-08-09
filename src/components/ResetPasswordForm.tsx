"use client";

import { useSearchParams } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

type Status = "idle" | "submitting" | "success" | "error";

export function ResetPasswordForm() {
  const formId = useId();
  const token = useSearchParams().get("token");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setStatus("submitting");
    setErrorMessage(null);
    const data = new FormData(event.currentTarget);

    try {
      const response = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: String(data.get("password") ?? "") }),
      });
      if (response.ok) {
        setStatus("success");
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setStatus("error");
      setErrorMessage(body?.message ?? "This reset link is invalid or has expired.");
    } catch {
      setStatus("error");
      setErrorMessage("Something went wrong. Please check your connection and try again.");
    }
  }

  if (!token) {
    return (
      <p className="form-status form-status--error" role="alert" style={{ maxWidth: "28rem" }}>
        This reset link is missing its token. Please use the link from your email.
      </p>
    );
  }

  if (status === "success") {
    return (
      <p className="form-status form-status--success" role="status" style={{ maxWidth: "28rem" }}>
        Your password has been reset. You can now <a href="/login">sign in</a> with your new password.
      </p>
    );
  }

  return (
    <form className="early-access-form" onSubmit={handleSubmit} noValidate style={{ maxWidth: "28rem" }}>
      <div className="field">
        <label htmlFor={`${formId}-password`}>New password</label>
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

      {status === "error" && errorMessage ? (
        <p className="form-status form-status--error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button type="submit" className="button button--primary button--large" disabled={status === "submitting"}>
        {status === "submitting" ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}
