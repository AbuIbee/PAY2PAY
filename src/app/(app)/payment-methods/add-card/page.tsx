import type { Metadata } from "next";
import { AddFinancialAccountForm } from "@/components/AddFinancialAccountForm";

export const metadata: Metadata = { title: "Add debit card" };

export default function AddDebitCardPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Add debit card</h1>
      </div>
      <AddFinancialAccountForm accountType="debit_card" />
    </div>
  );
}
