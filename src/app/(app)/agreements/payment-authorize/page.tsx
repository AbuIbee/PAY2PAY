import type { Metadata } from "next";
import { Suspense } from "react";
import { AgreementPaymentAuthorize } from "@/components/AgreementPaymentAuthorize";

export const metadata: Metadata = { title: "Authorize payment method" };

export default function AgreementPaymentAuthorizePage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Authorize payment method</h1>
      </div>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <AgreementPaymentAuthorize />
      </Suspense>
    </div>
  );
}
