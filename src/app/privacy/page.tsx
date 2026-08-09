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
        PAY2PAY is currently in its product-development stage. At this stage, the only personal
        information collected through this site is what you voluntarily submit through the
        early-access form (name, email, account type, business name where applicable, state,
        intended use, approximate agreement volume, and optional notes). That information is used
        only to follow up about early access and is not sold or shared with third parties for
        marketing.
      </p>
      <p>
        A complete privacy policy — covering data retention, your rights, and how information is
        handled once real accounts, agreements, and payments are enabled — will be published after
        legal review.
      </p>
    </LegalPlaceholder>
  );
}
