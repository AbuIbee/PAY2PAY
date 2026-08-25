"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { relationshipStatusLabel } from "@/lib/ui/statusLabels";
import { formatDate } from "@/lib/ui/date";
import { useActiveParty } from "./connections/useActiveParty";

interface RelationshipRecord {
  id: string;
  status: string;
  currentAgreementId: string | null;
  createdAt: string;
  updatedAt: string;
}

const NEXT_ACTION: Record<string, string> = {
  invited: "Waiting for your counterparty to respond",
  counterparty_linked: "Set up funding and receiving accounts",
  identities_confirmed: "Set up funding and receiving accounts",
  financial_setup_pending: "Finish adding financial accounts",
  financial_accounts_ready: "Set up the governing agreement",
  agreement_pending: "Complete the agreement",
  agreement_ready: "Send the agreement for signature",
  signature_pending: "Waiting for signatures",
  signed: "Activate the relationship",
  active: "No action needed",
  restricted: "Contact support",
  suspended: "Contact support",
  closed: "None — closed",
  cancelled: "None — cancelled",
};

type LoadStatus = "loading" | "ready" | "unauthorized" | "error";

export function ConnectionsList() {
  const { party, status: partyStatus } = useActiveParty();
  const [relationships, setRelationships] = useState<RelationshipRecord[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");

  useEffect(() => {
    if (partyStatus !== "ready" || !party) return;
    let cancelled = false;
    apiFetch<{ relationships: RelationshipRecord[] }>(
      `/api/relationships?partyKind=${party.kind}&partyId=${party.id}`,
    )
      .then((body) => {
        if (!cancelled) {
          setRelationships(body.relationships);
          setLoadStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setLoadStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [party, partyStatus]);

  if (partyStatus === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        You need to <a href="/login">sign in</a> to view your connections.
      </p>
    );
  }

  if (loadStatus === "loading" || partyStatus === "loading") {
    return (
      <div className="card-grid" aria-hidden="true">
        <div className="skeleton skeleton--card" />
        <div className="skeleton skeleton--card" />
      </div>
    );
  }

  if (loadStatus === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert">
        You need to <a href="/login">sign in</a> to view your connections.
      </p>
    );
  }

  if (loadStatus === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong loading your connections. Please try again.
      </p>
    );
  }

  if (relationships.length === 0) {
    return (
      <div className="empty-state">
        <h3>No connections yet</h3>
        <p>Propose a payment plan to start a repayment relationship — no existing connection required.</p>
        <Link href="/agreements/invite" className="button button--primary">
          Propose a payment plan
        </Link>
      </div>
    );
  }

  return (
    <div className="table-wrap table-wrap--responsive-cards">
      <table className="table">
        <thead>
          <tr>
            <th>Connection</th>
            <th>Status</th>
            <th>Next action</th>
          </tr>
        </thead>
        <tbody>
          {relationships.map((relationship) => {
            const { label, tone } = relationshipStatusLabel(relationship.status as never);
            return (
              <tr key={relationship.id}>
                <td data-label="Connection">
                  <Link href={`/connections/detail?id=${relationship.id}`} className="table-row-link">
                    Connection opened {formatDate(relationship.createdAt)}
                  </Link>
                </td>
                <td data-label="Status">
                  <span className={`chip chip--${tone}`}>{label}</span>
                </td>
                <td data-label="Next action">{NEXT_ACTION[relationship.status] ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
