import type { Metadata } from "next";
import Link from "next/link";
import { LegalPlaceholder } from "@/components/LegalPlaceholder";

export const metadata: Metadata = {
  title: "Support",
};

export default function SupportPage() {
  return (
    <LegalPlaceholder
      title="Support"
      intro="How to reach PAY2PAY — support channels are not live yet."
    >
      <p>
        PAY2PAY is currently in its product-development stage, and there is no live account or
        agreement functionality to provide support for yet. A dedicated support channel will be
        published here once real accounts, agreements, and payments are enabled.
      </p>
      <p>
        In the meantime, you can join the <Link href="/#early-access">early-access list</Link> and
        include a note describing your question — we read every submission.
      </p>
    </LegalPlaceholder>
  );
}
