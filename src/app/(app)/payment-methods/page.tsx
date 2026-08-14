import type { Metadata } from "next";
import Link from "next/link";
import { PaymentMethodsList } from "@/components/PaymentMethodsList";

export const metadata: Metadata = { title: "Payment Methods" };

export default function PaymentMethodsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>Payment Methods</h1>
          <p className="app-page__lede">
            Manage the bank accounts and debit cards you use to fund and receive payments.
          </p>
        </div>
        <div className="hero__actions">
          <Link href="/payment-methods/add-bank" className="button button--primary">
            Add bank account
          </Link>
          <Link href="/payment-methods/add-card" className="button button--ghost">
            Add debit card
          </Link>
        </div>
      </div>
      <PaymentMethodsList />
    </div>
  );
}
