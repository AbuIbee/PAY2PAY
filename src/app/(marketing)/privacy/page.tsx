import type { Metadata } from "next";
import { LegalPlaceholder } from "@/components/LegalPlaceholder";
import { CURRENT_LEGAL_DOCUMENT_VERSIONS } from "@/lib/legal/legalDocumentVersions";

export const metadata: Metadata = {
  title: "Privacy Policy",
};

export default function PrivacyPage() {
  return (
    <LegalPlaceholder
      title="Privacy Policy"
      intro="How PAY2PAY collects, uses, and protects information."
      version={CURRENT_LEGAL_DOCUMENT_VERSIONS.privacy}
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
      <h2>Business accounts and verification data</h2>
      <p>
        A Business organization account additionally involves: business identity information
        (legal name, formation details, address) submitted for business verification; an
        authorized representative&apos;s contact information; Tax ID/EIN information submitted for
        verification purposes — PAY2PAY&apos;s own systems never store the full Tax ID/EIN, only
        its last 4 digits for reference, with the full value transmitted only to our verification
        provider; subscription billing information, including payment-method metadata (such as a
        card&apos;s last 4 digits) stored by PAY2PAY, while full payment credentials are held only
        by our payment/billing provider, never by PAY2PAY directly; and an audit record of
        organization administrative actions (such as role or team-membership changes), retained
        for the organization&apos;s own security and compliance visibility.
      </p>
    </LegalPlaceholder>
  );
}
