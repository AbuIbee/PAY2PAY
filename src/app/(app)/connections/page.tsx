import type { Metadata } from "next";
import Link from "next/link";
import { ConnectionsList } from "@/components/ConnectionsList";

export const metadata: Metadata = { title: "Connections" };

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
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <Link href="/connections/invitations" className="button button--ghost">
            Invitations
          </Link>
          <Link href="/connections/invite" className="button button--primary">
            Invite a counterparty
          </Link>
        </div>
      </div>
      <ConnectionsList />
    </div>
  );
}
