import type { Metadata } from "next";
import { BankConnectionForm } from "@/components/BankConnectionForm";

export const metadata: Metadata = { title: "Connect bank account" };

export default function AddBankAccountPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Connect bank account</h1>
      </div>
      <BankConnectionForm />
    </div>
  );
}
