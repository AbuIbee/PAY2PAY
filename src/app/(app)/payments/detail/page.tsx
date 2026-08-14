import type { Metadata } from "next";
import { Suspense } from "react";
import { PaymentDetail } from "@/components/PaymentDetail";

export const metadata: Metadata = { title: "Payment" };

export default function PaymentDetailPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Payment</h1>
      </div>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <PaymentDetail />
      </Suspense>
    </div>
  );
}
