"use client";

import { useId, useState, type FormEvent } from "react";

type Status = "idle" | "submitting" | "success" | "error";

export function ForgotPasswordForm() {
  const formId = useId();
  const [status, setStatus] = useState<Status>("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    const data = new FormData(event.currentTarget);
    try {
      await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: String(data.get("email") ?? "") }),
      });
    } finally {
      // Always show the same success state, matching the API's
      // enumeration-resistant response — see requestPasswordReset's doc comment.
      setStatus("success");
    }
  }

  if (status === "success") {
    return (
      <p className="form-status form-status--success" role="status" style={{ maxWidth: "28rem" }}>
        If that email has an account, a reset link has been sent.
      </p>
    );
  }

  return (
    <form className="early-access-form" onSubmit={handleSubmit} noValidate style={{ maxWidth: "28rem" }}>
      <div className="field">
        <label htmlFor={`${formId}-email`}>Email</label>
        <input id={`${formId}-email`} name="email" type="email" autoComplete="email" required maxLength={254} />
      </div>
      <button type="submit" className="button button--primary button--large" disabled={status === "submitting"}>
        {status === "submitting" ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
