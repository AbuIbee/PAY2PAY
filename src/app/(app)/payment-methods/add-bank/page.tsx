import type { Metadata } from "next";
import { AddFinancialAccountForm } from "@/components/AddFinancialAccountForm";

export const metadata: Metadata = { title: "Add bank account" };

export default function AddBankAccountPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Add bank account</h1>
      </div>
      <AddFinancialAccountForm accountType="bank_account" />
    </div>
  );
}
