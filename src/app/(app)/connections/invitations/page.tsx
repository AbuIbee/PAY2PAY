import type { Metadata } from "next";
import { ConnectionsInvitations } from "@/components/ConnectionsInvitations";

export const metadata: Metadata = { title: "Invitations" };

export default function ConnectionsInvitationsPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Invitations</h1>
      </div>
      <ConnectionsInvitations />
    </div>
  );
}
