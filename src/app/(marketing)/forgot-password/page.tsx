import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/ForgotPasswordForm";

export const metadata: Metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
        Reset your password
      </h1>
      <p style={{ color: "var(--ink-soft)", maxWidth: "28rem", marginBottom: "1.5rem" }}>
        Enter your email and we&apos;ll send a link to reset your password.
      </p>
      <ForgotPasswordForm />
    </article>
  );
}
