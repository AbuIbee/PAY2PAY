"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type Status = "idle" | "verifying" | "success" | "error";

/** Decision 6: confirms a NEW preferred email — distinct from, and never touching, the auth/login email verified by VerifyEmailStatus. */
export function PreferredEmailVerifyStatus() {
  const token = useSearchParams().get("token");
  const [status, setStatus] = useState<Status>(token ? "verifying" : "idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch("/api/profiles/personal/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        if (cancelled) return;
        if (response.ok) {
          setStatus("success");
          return;
        }
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        setStatus("error");
        setErrorMessage(body?.message ?? "This verification link is invalid or has expired.");
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
          setErrorMessage("Something went wrong. Please check your connection and try again.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return (
      <p className="form-status form-status--error" role="alert" style={{ maxWidth: "28rem" }}>
        This verification link is missing its token. Please use the link from your email.
      </p>
    );
  }

  if (status === "success") {
    return (
      <p className="form-status form-status--success" role="status" style={{ maxWidth: "28rem" }}>
        Your preferred email is verified. You can <a href="/account/profile">return to your profile</a>.
      </p>
    );
  }

  if (status === "error") {
    return (
      <p className="form-status form-status--error" role="alert" style={{ maxWidth: "28rem" }}>
        {errorMessage}
      </p>
    );
  }

  return (
    <p role="status" style={{ maxWidth: "28rem" }}>
      Verifying…
    </p>
  );
}
