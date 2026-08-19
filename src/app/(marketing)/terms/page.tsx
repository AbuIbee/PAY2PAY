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
        PAY2PAY is currently in pre-launch testing. Account, agreement, signature, and payment
        functionality exists in the product for testing purposes, but no version of these Terms of
        Service has yet been reviewed by counsel, and no functionality here should be relied on as
        a finished, legally binding commercial service.
      </p>
      <p>
        Complete, counsel-reviewed terms of service will be published before any public or
        production launch.
      </p>
    </LegalPlaceholder>
  );
}
