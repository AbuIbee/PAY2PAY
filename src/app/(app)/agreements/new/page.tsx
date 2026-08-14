import type { Metadata } from "next";
import { AgreementCreateWizard } from "@/components/AgreementCreateWizard";

export const metadata: Metadata = { title: "New agreement" };

export default function NewAgreementPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>New agreement</h1>
      </div>
      <AgreementCreateWizard />
    </div>
  );
}
