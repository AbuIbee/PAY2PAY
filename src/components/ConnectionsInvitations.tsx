"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/ui/apiFetch";
import { relationshipInvitationStatusLabel } from "@/lib/ui/statusLabels";
import { useActiveParty } from "./connections/useActiveParty";

interface RelationshipRecord {
  id: string;
  status: string;
}

interface InvitationRecord {
  id: string;
  relationshipId: string;
  inviteeEmail: string;
  inviteeRole: "creditor" | "debtor";
  status: string;
  expiresAt: string;
}

type LoadStatus = "loading" | "ready" | "error" | "unauthorized";

/**
 * "Sent invitations" tab lists invitations the caller created (relationships
 * still in status "invited" — the only reliable signal an invitation is
 * still outstanding, since acceptance immediately advances the relationship
 * past that status). "Pending invitations" (received) has no list endpoint
 * to call — RelationshipInvitationService never creates a participant row
 * for the invitee until they accept, so there is no query surface to find
 * "invitations addressed to me" before that point (see
 * docs/SPRINT_18B_UI_INTEGRATION_MATRIX.md's Connections section); the
 * architecture is notification-driven instead — see the explanatory text
 * below rather than a fake empty list.
 */
export function ConnectionsInvitations() {
  const { party, status: partyStatus } = useActiveParty();
  const [invitations, setInvitations] = useState<InvitationRecord[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (partyStatus === "error") {
      setLoadStatus("unauthorized");
      return;
    }
    if (partyStatus !== "ready" || !party) return;
    try {
      const { relationships } = await apiFetch<{ relationships: RelationshipRecord[] }>(
        `/api/relationships?partyKind=${party.kind}&partyId=${party.id}`,
      );
      const invited = relationships.filter((r) => r.status === "invited");
      const lists = await Promise.all(
        invited.map((r) =>
          apiFetch<{ invitations: InvitationRecord[] }>(`/api/relationships/invitations?relationshipId=${r.id}`).then(
            (body) => body.invitations,
          ),
        ),
      );
      setInvitations(lists.flat().filter((i) => i.status === "sent" || i.status === "viewed"));
      setLoadStatus("ready");
    } catch {
      setLoadStatus("error");
    }
  }, [party, partyStatus]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function handleCancel(invitationId: string) {
    setActionError(null);
    try {
      await apiFetch("/api/relationships/invite/cancel", {
        method: "POST",
        body: JSON.stringify({ invitationId }),
      });
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not cancel this invitation.");
    }
  }

  return (
    <div style={{ display: "grid", gap: "2rem" }}>
      <section>
        <h2 style={{ marginTop: 0 }}>Sent invitations</h2>
        {loadStatus === "loading" && <div className="skeleton skeleton--card" aria-hidden="true" />}
        {loadStatus === "unauthorized" && (
          <p className="form-status form-status--error" role="alert">
            You need to <a href="/login">sign in</a> to view invitations.
          </p>
        )}
        {loadStatus === "error" && (
          <p className="form-status form-status--error" role="alert">
            Something went wrong loading invitations. Please try again.
          </p>
        )}
        {loadStatus === "ready" && invitations.length === 0 && (
          <div className="empty-state">
            <h3>No open invitations</h3>
            <p>Invitations you send that haven&apos;t been accepted or declined will appear here.</p>
            <Link href="/connections/invite" className="button button--primary">
              Invite a counterparty
            </Link>
          </div>
        )}
        {loadStatus === "ready" && invitations.length > 0 && (
          <div className="table-wrap table-wrap--responsive-cards">
            <table className="table">
              <thead>
                <tr>
                  <th>Invitee</th>
                  <th>Their role</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => {
                  const { label, tone } = relationshipInvitationStatusLabel(invitation.status as never);
                  return (
                    <tr key={invitation.id}>
                      <td data-label="Invitee">{invitation.inviteeEmail}</td>
                      <td data-label="Their role">{invitation.inviteeRole === "creditor" ? "Creditor" : "Debtor"}</td>
                      <td data-label="Status">
                        <span className={`chip chip--${tone}`}>{label}</span>
                      </td>
                      <td data-label="">
                        <button type="button" className="button button--ghost" onClick={() => void handleCancel(invitation.id)}>
                          Cancel
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {actionError && (
          <p className="field-error" role="alert">
            {actionError}
          </p>
        )}
      </section>

      <section>
        <h2>Pending invitations</h2>
        <p className="app-page__lede">
          If someone has invited you to a connection, you&apos;ll receive a notification with a link to accept or
          decline it — check your Notifications or the email address linked to your account.
        </p>
      </section>
    </div>
  );
}
