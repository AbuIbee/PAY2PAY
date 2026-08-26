import type { Metadata } from "next";
import Link from "next/link";
import { AgreementsList } from "@/components/AgreementsList";

export const metadata: Metadata = { title: "Payment Arrangements" };

export default function AgreementsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>Payment Arrangements</h1>
          <p className="app-page__lede">
            Repayment agreements you&apos;ve created, signed, or are waiting on — organized by status.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Link href="/agreements/invite" className="button button--ghost">
            Invite someone
          </Link>
          <Link href="/agreements/new" className="button button--primary">
            New agreement
          </Link>
        </div>
      </div>
      <AgreementsList />
    </div>
  );
}
