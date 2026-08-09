import type { Metadata } from "next";
import { SignupForm } from "@/components/SignupForm";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
        Create your account
      </h1>
      <p style={{ color: "var(--ink-soft)", maxWidth: "28rem", marginBottom: "1.5rem" }}>
        This creates a real account for signing in — it does not yet include agreements, signatures,
        or payments.
      </p>
      <SignupForm />
    </article>
  );
}
