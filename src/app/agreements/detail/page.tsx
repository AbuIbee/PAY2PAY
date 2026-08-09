import type { Metadata } from "next";
import { Suspense } from "react";
import { AgreementDetail } from "@/components/AgreementDetail";

export const metadata: Metadata = { title: "Agreement" };

export default function AgreementDetailPage() {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
        Agreement
      </h1>
      <div style={{ marginTop: "1.5rem" }}>
        <Suspense fallback={<p role="status">Loading…</p>}>
          <AgreementDetail />
        </Suspense>
      </div>
    </article>
  );
}
