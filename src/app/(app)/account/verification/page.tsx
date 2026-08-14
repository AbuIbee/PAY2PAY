import type { Metadata } from "next";
import { AccountVerification } from "@/components/AccountVerification";

export const metadata: Metadata = { title: "Verification & plan" };

export default function AccountVerificationPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Verification &amp; plan</h1>
      </div>
      <AccountVerification />
    </div>
  );
}
