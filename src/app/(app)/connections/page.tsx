import type { Metadata } from "next";
import { ConnectionsList } from "@/components/ConnectionsList";

export const metadata: Metadata = { title: "Connections" };

/**
 * Agreement Lifecycle V2 UAT (Defect 4): the "Invitations" and "Invite a counterparty" entry
 * points previously lived here — removed per Product Owner direction; counterparty invitation is
 * now initiated only through the Agreement workflow ("Send secure invitation", InviteToAgreement.tsx)
 * and the New Agreement wizard's own connection prompt, not from this tab. The underlying
 * relationship/invitation services and pages are untouched — only these two entry points into them
 * are gone; a still-pending invitation remains reachable via the dashboard's own action card.
 */
export default function ConnectionsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>Connections</h1>
          <p className="app-page__lede">
            Everyone you have an active or pending repayment relationship with.
          </p>
        </div>
      </div>
      <ConnectionsList />
    </div>
  );
}
