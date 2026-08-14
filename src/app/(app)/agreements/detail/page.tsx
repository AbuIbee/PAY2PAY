import type { Metadata } from "next";
import { Suspense } from "react";
import { AgreementDetail } from "@/components/AgreementDetail";

export const metadata: Metadata = { title: "Agreement" };

export default function AgreementDetailPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Agreement</h1>
      </div>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <AgreementDetail />
      </Suspense>
    </div>
  );
}
