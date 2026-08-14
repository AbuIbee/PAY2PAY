import type { Metadata } from "next";
import { InviteConnectionWizard } from "@/components/InviteConnectionWizard";

export const metadata: Metadata = { title: "Invite a counterparty" };

export default function InviteConnectionPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Invite a counterparty</h1>
      </div>
      <InviteConnectionWizard />
    </div>
  );
}
