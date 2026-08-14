import type { Metadata } from "next";
import { PaymentsList } from "@/components/PaymentsList";

export const metadata: Metadata = { title: "Payments" };

export default function PaymentsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Payments</h1>
      </div>
      <PaymentsList />
    </div>
  );
}
