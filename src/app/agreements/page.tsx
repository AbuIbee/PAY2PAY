import type { Metadata } from "next";
import { AgreementsList } from "@/components/AgreementsList";

export const metadata: Metadata = { title: "Agreements" };

export default function AgreementsPage() {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
        Agreements
      </h1>
      <div style={{ marginTop: "1.5rem" }}>
        <AgreementsList />
      </div>
    </article>
  );
}
