import type { Metadata } from "next";
import { Suspense } from "react";
import { SignupForm } from "@/components/SignupForm";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
        Create your account
      </h1>
      <p style={{ color: "var(--ink-soft)", maxWidth: "28rem", marginBottom: "1.5rem" }}>
        Sign up to create agreements, sign them, and manage payments.
      </p>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <SignupForm />
      </Suspense>
    </article>
  );
}
