import type { Metadata } from "next";
import { LegalPlaceholder } from "@/components/LegalPlaceholder";

export const metadata: Metadata = {
  title: "Terms of Service",
};

export default function TermsPage() {
  return (
    <LegalPlaceholder
      title="Terms of Service"
      intro="The rules for using PAY2PAY — not yet finalized."
    >
      <p>
        PAY2PAY is currently in its product-development stage. No accounts, agreements,
        signatures, or payments are enabled on this site, so no service is being provided under
        these terms yet. Submitting the early-access form does not create a binding agreement of
        any kind between you and PAY2PAY.
      </p>
      <p>
        Complete terms of service will be published, after legal review, before any account,
        agreement, or payment functionality goes live.
      </p>
    </LegalPlaceholder>
  );
}
