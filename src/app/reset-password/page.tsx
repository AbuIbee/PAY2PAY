import type { Metadata } from "next";
import { Suspense } from "react";
import { ResetPasswordForm } from "@/components/ResetPasswordForm";

export const metadata: Metadata = { title: "Reset password" };

export default function ResetPasswordPage() {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
        Choose a new password
      </h1>
      <div style={{ marginTop: "1.5rem" }}>
        <Suspense fallback={<p role="status">Loading…</p>}>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </article>
  );
}
