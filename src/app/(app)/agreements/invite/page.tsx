import type { Metadata } from "next";
import { InviteToAgreement } from "@/components/InviteToAgreement";

export const metadata: Metadata = { title: "Invite to a payment plan" };

export default function AgreementInvitePage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Invite someone to a payment plan</h1>
      </div>
      <p style={{ maxWidth: "34rem" }}>
        Propose terms to anyone by name, email, or mobile number — they can review securely and respond without creating an
        account first.
      </p>
      <InviteToAgreement />
    </div>
  );
}
