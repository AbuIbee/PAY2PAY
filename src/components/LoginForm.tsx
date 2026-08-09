"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

type Status = "idle" | "submitting" | "success" | "error";

export function LoginForm() {
  const formId = useId();
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);

    const data = new FormData(event.currentTarget);
    const payload = { email: String(data.get("email") ?? ""), password: String(data.get("password") ?? "") };

    try {
      const response = await fetch("/api/auth/login", {
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
      setErrorMessage(
        response.status === 403
          ? body?.message ?? "This account has been disabled."
          : body?.message ?? "Invalid email or password.",
      );
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
          autoComplete="current-password"
          required
        />
      </div>

      {status === "error" && errorMessage ? (
        <p className="form-status form-status--error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button type="submit" className="button button--primary button--large" disabled={status === "submitting"}>
        {status === "submitting" ? "Signing in…" : "Sign in"}
      </button>

      <p style={{ fontSize: "0.85rem", color: "var(--ink-soft)" }}>
        <Link href="/forgot-password">Forgot your password?</Link>
        {" · "}
        <Link href="/signup">Create an account</Link>
      </p>
    </form>
  );
}
