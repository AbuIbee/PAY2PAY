import type { Metadata } from "next";
import { LegalPlaceholder } from "@/components/LegalPlaceholder";
import { CURRENT_LEGAL_DOCUMENT_VERSIONS } from "@/lib/legal/legalDocumentVersions";

export const metadata: Metadata = {
  title: "Terms of Service",
};

export default function TermsPage() {
  return (
    <LegalPlaceholder
      title="Terms of Service"
      intro="The rules for using PAY2PAY."
      version={CURRENT_LEGAL_DOCUMENT_VERSIONS.terms}
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
      <h2>Business organization accounts</h2>
      <p>
        An individual may also create and administer a Business organization account, separate
        from their Personal account. A Business account can have multiple team members, each
        assigned a role that determines what they can see and do within that organization — see
        the <code>Business Subscription Policy</code> for how a Business organization is billed.
        Removing a team member revokes their access; it does not delete the records they created on
        the organization&apos;s behalf.
      </p>
    </LegalPlaceholder>
  );
}
