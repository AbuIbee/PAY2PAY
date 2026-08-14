"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
import { relationshipStatusLabel, financialAccountStatusLabel } from "@/lib/ui/statusLabels";
import { buildSetupSteps, type SetupStep } from "./connections/setupTracker";
import { participantLabel, type ParticipantLike } from "./connections/participantLabels";

interface RelationshipRecord {
  id: string;
  status: string;
  currentAgreementId: string | null;
  createdAt: string;
}

interface FinancialAccountRecord {
  id: string;
  accountType: "bank_account" | "debit_card";
  maskedLast4: string | null;
  institutionDisplayName: string | null;
  status: string;
  individualProfileId: string | null;
  organizationId: string | null;
}

interface AssignmentRecord {
  id: string;
  usage: "funding" | "payout";
  status: string;
  financialAccount: FinancialAccountRecord;
}

type LoadStatus = "loading" | "ready" | "error" | "not_found";

export function ConnectionDetail() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [relationship, setRelationship] = useState<RelationshipRecord | null>(null);
  const [participants, setParticipants] = useState<ParticipantLike[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRecord[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myAccounts, setMyAccounts] = useState<FinancialAccountRecord[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const me = await apiFetch<{ id: string; email: string }>("/api/auth/me");
      setMyUserId(me.id);

      const detail = await apiFetch<{ relationship: RelationshipRecord; participants: ParticipantLike[] }>(
        `/api/relationships/detail?id=${id}`,
      );
      setRelationship(detail.relationship);
      setParticipants(detail.participants);

      const check = await apiFetch<{ eligible: boolean; reasons: string[] }>(
        `/api/relationships/activate/check?relationshipId=${id}`,
      );
      setReasons(check.reasons);

      const accounts = await apiFetch<{ assignments: AssignmentRecord[] }>(
        `/api/relationships/accounts?relationshipId=${id}`,
      );
      setAssignments(accounts.assignments);

      const mine = detail.participants.find((p) => p.representedByUserId === me.id);
      if (mine) {
        const party = mine.individualProfileId
          ? { kind: "personal" as const, id: mine.individualProfileId }
          : { kind: "business" as const, id: mine.organizationId! };
        const partyAccounts = await apiFetch<{ accounts: FinancialAccountRecord[] }>(
          `/api/relationships/accounts/party?partyKind=${party.kind}&partyId=${party.id}`,
        );
        setMyAccounts(partyAccounts.accounts.filter((a) => a.status === "verified"));
      }

      setLoadStatus("ready");
    } catch (error) {
      if (error instanceof ApiError && error.httpStatus === 400) {
        setLoadStatus("not_found");
      } else {
        setLoadStatus("error");
      }
    }
  }, [id]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function handleActivate() {
    if (!id) return;
    setActionPending(true);
    setActionError(null);
    try {
      await apiFetch("/api/relationships/activate", { method: "POST", body: JSON.stringify({ relationshipId: id }) });
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not activate this relationship.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleClose() {
    if (!id) return;
    if (!window.confirm("Close this connection? This does not erase any agreement, payment, or dispute history.")) return;
    setActionPending(true);
    setActionError(null);
    try {
      await apiFetch("/api/relationships/close", { method: "POST", body: JSON.stringify({ relationshipId: id }) });
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not close this connection.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleAssign(usage: "funding" | "payout", financialAccountId: string, alreadyAssigned: boolean) {
    if (!id || !financialAccountId) return;
    setActionPending(true);
    setActionError(null);
    try {
      const endpoint = alreadyAssigned ? "/api/relationships/accounts/replace" : "/api/relationships/accounts/assign";
      await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ relationshipId: id, financialAccountId, usage }),
      });
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update this account assignment.");
    } finally {
      setActionPending(false);
    }
  }

  if (!id) {
    return (
      <p className="form-status form-status--error" role="alert">
        No connection was specified.
      </p>
    );
  }

  if (loadStatus === "loading") {
    return (
      <div aria-hidden="true">
        <div className="skeleton skeleton--line" style={{ width: "40%" }} />
        <div className="skeleton skeleton--card" />
      </div>
    );
  }

  if (loadStatus === "not_found") {
    return (
      <p className="form-status form-status--error" role="alert">
        This connection could not be found, or you do not have access to it.
      </p>
    );
  }

  if (loadStatus === "error" || !relationship) {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong loading this connection. Please try again.
      </p>
    );
  }

  const { label, tone } = relationshipStatusLabel(relationship.status as never);
  const steps: SetupStep[] = buildSetupSteps(reasons, relationship.status);
  const funding = assignments.find((a) => a.usage === "funding" && a.status === "active");
  const payout = assignments.find((a) => a.usage === "payout" && a.status === "active");
  const canActivate = reasons.length === 0 && relationship.status !== "active";
  const canClose = !["closed", "cancelled"].includes(relationship.status);

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <div className="card">
        <div className="card__header">
          <h2>Status</h2>
          <span className={`chip chip--${tone}`}>{label}</span>
        </div>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" }}>
          {participants.map((participant) => (
            <li key={participant.id}>{participantLabel(participant, myUserId)}</li>
          ))}
        </ul>
      </div>

      <div className="card">
        <div className="card__header">
          <h2>Setup progress</h2>
        </div>
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.6rem" }}>
          {steps.map((step) => (
            <li key={step.label} style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <span
                className={`chip chip--${step.complete ? "success" : "neutral"}`}
                aria-label={step.complete ? "Complete" : "Not yet complete"}
              >
                {step.complete ? "Done" : "Pending"}
              </span>
              <span>{step.label}</span>
            </li>
          ))}
        </ol>
        {canActivate && (
          <div style={{ marginTop: "1rem" }}>
            <button type="button" className="button button--primary" onClick={() => void handleActivate()} disabled={actionPending}>
              Activate relationship
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card__header">
          <h2>Accounts</h2>
        </div>
        <AccountAssignmentRow
          title="Pay from (funding)"
          usage="funding"
          current={funding}
          myAccounts={myAccounts}
          onAssign={handleAssign}
          disabled={actionPending || myAccounts.length === 0}
        />
        <AccountAssignmentRow
          title="Receive to (payout)"
          usage="payout"
          current={payout}
          myAccounts={myAccounts}
          onAssign={handleAssign}
          disabled={actionPending || myAccounts.length === 0}
        />
        {myAccounts.length === 0 && (
          <p className="app-page__lede">
            You have no verified payment methods yet. Add one from{" "}
            <a href="/payment-methods">Payment Methods</a>.
          </p>
        )}
      </div>

      {actionError && (
        <p className="field-error" role="alert">
          {actionError}
        </p>
      )}

      {canClose && (
        <div>
          <button type="button" className="button button--ghost" onClick={() => void handleClose()} disabled={actionPending}>
            Close connection
          </button>
        </div>
      )}
    </div>
  );
}

function AccountAssignmentRow({
  title,
  usage,
  current,
  myAccounts,
  onAssign,
  disabled,
}: {
  title: string;
  usage: "funding" | "payout";
  current: AssignmentRecord | undefined;
  myAccounts: FinancialAccountRecord[];
  onAssign: (usage: "funding" | "payout", financialAccountId: string, alreadyAssigned: boolean) => void;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState("");
  const currentStatus = current ? financialAccountStatusLabel(current.financialAccount.status as never) : null;

  return (
    <div style={{ paddingBlock: "0.75rem", borderBottom: "1px solid var(--border)" }}>
      <strong>{title}</strong>
      {current ? (
        <p style={{ margin: "0.35rem 0" }}>
          {current.financialAccount.institutionDisplayName ?? "Account"} ending {current.financialAccount.maskedLast4 ?? "----"}{" "}
          {currentStatus && <span className={`chip chip--${currentStatus.tone}`}>{currentStatus.label}</span>}
        </p>
      ) : (
        <p style={{ margin: "0.35rem 0", color: "var(--ink-soft)" }}>Not yet assigned.</p>
      )}
      {myAccounts.length > 0 && (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <select
            aria-label={`Select account for ${title}`}
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Choose a verified account…</option>
            {myAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.institutionDisplayName ?? "Account"} ending {account.maskedLast4 ?? "----"}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button button--ghost"
            disabled={disabled || !selected}
            onClick={() => {
              if (
                current &&
                !window.confirm("Replacing this account changes where future payments are routed. Continue?")
              ) {
                return;
              }
              onAssign(usage, selected, !!current);
              setSelected("");
            }}
          >
            {current ? "Replace" : "Assign"}
          </button>
        </div>
      )}
    </div>
  );
}
