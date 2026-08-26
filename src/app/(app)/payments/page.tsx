import type { Metadata } from "next";
import { PaymentsList } from "@/components/PaymentsList";

export const metadata: Metadata = { title: "My Cash" };

export default function PaymentsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>My Cash</h1>
          <p className="app-page__lede">
            Every payment tied to your agreements — scheduled, completed, and failed.
          </p>
        </div>
      </div>
      <PaymentsList />
    </div>
  );
}
