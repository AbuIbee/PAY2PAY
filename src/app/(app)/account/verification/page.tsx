import type { Metadata } from "next";
import { AccountVerification } from "@/components/AccountVerification";

export const metadata: Metadata = { title: "Verification & plan" };

export default function AccountVerificationPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>Verification &amp; plan</h1>
          <p className="app-page__lede">
            Full verification is reviewed by our team before you can sign agreements or send and
            receive payments — it isn&apos;t automatic or self-approved.
          </p>
        </div>
      </div>
      <AccountVerification />
    </div>
  );
}
