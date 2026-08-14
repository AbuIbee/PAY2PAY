import type { Metadata } from "next";
import Link from "next/link";
import { AgreementsList } from "@/components/AgreementsList";

export const metadata: Metadata = { title: "Agreements" };

export default function AgreementsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Agreements</h1>
        <Link href="/agreements/new" className="button button--primary">
          New agreement
        </Link>
      </div>
      <AgreementsList />
    </div>
  );
}
