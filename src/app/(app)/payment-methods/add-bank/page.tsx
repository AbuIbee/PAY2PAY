import type { Metadata } from "next";
import { BankConnectionForm } from "@/components/BankConnectionForm";

export const metadata: Metadata = { title: "Connect bank account" };

/**
 * PAID2YOU — B0-D ADYEN PHASE 2 (item 6 — customer UI): re-enabled now that the real Adyen
 * collection flow (Sessions API + Web Component, `BankConnectionForm`) is available — replacing the
 * "Not yet available" placeholder B0-D TOTAL SANDBOX ELIMINATION put here (no live provider was
 * configured/capable of bank-account collection at that time; `adyen` now is — see
 * providerCapabilities.ts's `bank_linking` capability). `BankConnectionForm` itself independently
 * falls back to a controlled "Not yet available" state whenever `NEXT_PUBLIC_ADYEN_CLIENT_KEY` is not
 * configured — never attempting to collect anything without it — so this page degrades safely even if
 * that specific piece of configuration is missing in a given environment.
 */
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
