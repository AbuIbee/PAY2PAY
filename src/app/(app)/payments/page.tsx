import type { Metadata } from "next";
import { PaymentsList } from "@/components/PaymentsList";

export const metadata: Metadata = { title: "Payments" };

export default function PaymentsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>Payments</h1>
          <p className="app-page__lede">
            Every payment tied to your agreements — scheduled, completed, and failed.
          </p>
        </div>
      </div>
      <PaymentsList />
    </div>
  );
}
