import type { Metadata } from "next";
import { LegalPlaceholder } from "@/components/LegalPlaceholder";

export const metadata: Metadata = {
  title: "Privacy Policy",
};

export default function PrivacyPage() {
  return (
    <LegalPlaceholder
      title="Privacy Policy"
      intro="How PAY2PAY collects, uses, and protects information — not yet finalized."
    >
      <p>
        PAY2PAY is currently in pre-launch testing. The product collects account information
        (email, date of birth), agreement and payment records you or a counterparty create, and —
        for identity/business verification — information submitted through our financial and
        identity-verification providers. None of this information is sold, and it is not shared
        with third parties for marketing. A technical overview of what is collected and how it is
        minimized is maintained in this project&apos;s internal documentation
        (<code>docs/DATA_MODEL.md</code>), pending a complete, counsel-reviewed privacy policy.
      </p>
      <p>
        A complete privacy policy — covering data retention, your rights, and how information is
        handled — will be published, after legal review, before any public or production launch.
      </p>
    </LegalPlaceholder>
  );
}
