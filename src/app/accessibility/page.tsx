import type { Metadata } from "next";
import Link from "next/link";
import { LegalPlaceholder } from "@/components/LegalPlaceholder";

export const metadata: Metadata = {
  title: "Accessibility",
};

export default function AccessibilityPage() {
  return (
    <LegalPlaceholder
      title="Accessibility"
      intro="Our accessibility commitment and status — not yet finalized."
    >
      <p>
        PAY2PAY is being built with accessibility as a first-class requirement, including
        WCAG 2.2 AA as a baseline target (see{" "}
        <code>docs/deliverables/05-nonfunctional-requirements.md</code>). This site is in active
        development, so a formal accessibility conformance statement has not yet been published.
      </p>
      <p>
        If you encounter an accessibility barrier anywhere on this site, please reach out through
        the <Link href="/support">support</Link> page and describe what you experienced.
      </p>
    </LegalPlaceholder>
  );
}
