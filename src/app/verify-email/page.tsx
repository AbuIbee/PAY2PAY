import type { Metadata } from "next";
import { Suspense } from "react";
import { VerifyEmailStatus } from "@/components/VerifyEmailStatus";

export const metadata: Metadata = { title: "Verify email" };

export default function VerifyEmailPage() {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
        Verify your email
      </h1>
      <div style={{ marginTop: "1.5rem" }}>
        <Suspense fallback={<p role="status">Loading…</p>}>
          <VerifyEmailStatus />
        </Suspense>
      </div>
    </article>
  );
}
