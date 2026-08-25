"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AgreementTermsFields,
  BLANK_AGREEMENT_TERMS,
  type AgreementTermsFormValues,
} from "./AgreementTermsFields";
import type { SelectableProfile } from "./ProfileSwitcher";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
import { formatMoney } from "@/lib/ui/money";
import { relationshipStatusLabel, partyRoleLabel, feeAllocationLabel } from "@/lib/ui/statusLabels";

interface RelationshipSummary {
  id: string;
  status: string;
  currentAgreementId: string | null;
}

interface RelationshipParticipant {
  id: string;
  relationshipId: string;
  individualProfileId: string | null;
  organizationId: string | null;
  role: "creditor" | "debtor";
  representedByUserId: string | null;
}

interface CounterpartyRef {
  kind: "personal" | "business";
  id: string;
  role: "creditor" | "debtor";
}

type Step = "parties" | "terms" | "review";

/**
 * Agreement Lifecycle V2 (Next: Terms regression fix): a relationship is only usable as a new
 * agreement's counterparty connection once BOTH participants have actually joined it — "invited"
 * means only the inviter's own side exists yet, so `/api/relationships/detail` can never resolve a
 * second (counterparty) participant for it, and selecting one silently dead-ends the wizard with
 * "This connection doesn't have two confirmed participants yet," permanently disabling Next: Terms
 * with no explanation. The prior filter checked only `currentAgreementId === null`, which correctly
 * excludes a relationship already governing an agreement but never excluded a still-pending
 * invitation or a terminal (closed/cancelled/restricted/suspended) relationship.
 */
const NOT_YET_JOINED_STATUS = "invited";
const TERMINAL_STATUSES = ["restricted", "suspended", "closed", "cancelled"];
function isEligibleForNewAgreement(relationship: RelationshipSummary): boolean {
  return (
    relationship.currentAgreementId === null &&
    relationship.status !== NOT_YET_JOINED_STATUS &&
    !TERMINAL_STATUSES.includes(relationship.status)
  );
}

function profileRef(profile: SelectableProfile): { kind: "personal" | "business"; id: string } | null {
  if (profile.kind === "personal") return profile.personalProfileId ? { kind: "personal", id: profile.personalProfileId } : null;
  return profile.businessProfileId ? { kind: "business", id: profile.businessProfileId } : null;
}

/**
 * Sprint 18B agreement creation wizard: Parties -> Amount/obligation/Schedule/Terms -> Review ->
 * Submit, per the Sprint 18B prompt's exact wizard steps. Parties are drawn from an existing active
 * Sprint 18A connection (never a raw profile-id text field) so both parties' roles come from the
 * relationship itself, not a free-form picker that could disagree with it. After creating the draft,
 * links it to the chosen relationship (POST /api/relationships/link-agreement) so the relationship's
 * own setup tracker can progress, then redirects to the new agreement's detail page — where the
 * existing "Submit for debtor acknowledgment" action already lives, so this wizard only ever creates
 * a draft, never auto-submits it.
 */
export function AgreementCreateWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("parties");

  const [profiles, setProfiles] = useState<SelectableProfile[]>([]);
  const [actingProfile, setActingProfile] = useState<SelectableProfile | null>(null);
  const [relationships, setRelationships] = useState<RelationshipSummary[]>([]);
  const [hasAnyConnections, setHasAnyConnections] = useState(false);
  const [selectedRelationshipId, setSelectedRelationshipId] = useState<string>("");
  const [counterparty, setCounterparty] = useState<CounterpartyRef | null>(null);
  const [myRole, setMyRole] = useState<"creditor" | "debtor" | null>(null);
  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [partyError, setPartyError] = useState<string | null>(null);

  const [terms, setTerms] = useState<AgreementTermsFormValues>(BLANK_AGREEMENT_TERMS);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<{ profiles: SelectableProfile[] }>("/api/profiles");
        if (cancelled) return;
        setProfiles(body.profiles);
        setActingProfile(body.profiles[0] ?? null);
        setLoadStatus("ready");
      } catch {
        if (!cancelled) setLoadStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!actingProfile) return;
    const ref = profileRef(actingProfile);
    if (!ref) return;
    let cancelled = false;
    void (async () => {
      setSelectedRelationshipId("");
      setCounterparty(null);
      try {
        const body = await apiFetch<{ relationships: RelationshipSummary[] }>(
          `/api/relationships?partyKind=${ref.kind}&partyId=${ref.id}`,
        );
        if (!cancelled) {
          setHasAnyConnections(body.relationships.length > 0);
          setRelationships(body.relationships.filter(isEligibleForNewAgreement));
        }
      } catch {
        if (!cancelled) {
          setHasAnyConnections(false);
          setRelationships([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actingProfile]);

  async function handleSelectRelationship(relationshipId: string) {
    setSelectedRelationshipId(relationshipId);
    setCounterparty(null);
    setPartyError(null);
    if (!relationshipId || !actingProfile) return;
    const me = profileRef(actingProfile);
    if (!me) return;
    try {
      const body = await apiFetch<{ participants: RelationshipParticipant[] }>(
        `/api/relationships/detail?id=${encodeURIComponent(relationshipId)}`,
      );
      const mine = body.participants.find(
        (p) => (me.kind === "personal" ? p.individualProfileId : p.organizationId) === me.id,
      );
      const other = body.participants.find((p) => p !== mine);
      if (!mine || !other) {
        setPartyError("This connection doesn't have two confirmed participants yet.");
        return;
      }
      setMyRole(mine.role);
      setCounterparty({
        kind: other.individualProfileId ? "personal" : "business",
        id: (other.individualProfileId ?? other.organizationId) as string,
        role: other.role,
      });
    } catch {
      setPartyError("Could not load this connection's participants. Please try again.");
    }
  }

  async function handleSubmit() {
    if (!actingProfile || !counterparty || !myRole || submitting) return;
    const me = profileRef(actingProfile);
    if (!me) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const creditor = myRole === "creditor" ? me : { kind: counterparty.kind, id: counterparty.id };
      const debtor = myRole === "debtor" ? me : { kind: counterparty.kind, id: counterparty.id };
      const created = await apiFetch<{ id: string }>("/api/agreements", {
        method: "POST",
        body: JSON.stringify({ creditor, debtor, ...terms }),
      });
      await apiFetch("/api/relationships/link-agreement", {
        method: "POST",
        body: JSON.stringify({ relationshipId: selectedRelationshipId, agreementId: created.id }),
      });
      router.push(`/agreements/detail?id=${created.id}`);
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : "Something went wrong creating this agreement. Please try again.");
      setSubmitting(false);
    }
  }

  if (loadStatus === "loading") return <p role="status">Loading…</p>;
  if (loadStatus === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong. Please try again.
      </p>
    );
  }

  return (
    <div className="card" style={{ maxWidth: "40rem" }}>
      <div className="tabs" role="tablist" aria-label="Agreement creation steps">
        {(["parties", "terms", "review"] as Step[]).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            className="tab"
            aria-selected={step === s}
            onClick={() => setStep(s)}
          >
            {s === "parties" ? "1. Parties" : s === "terms" ? "2. Terms" : "3. Review"}
          </button>
        ))}
      </div>

      {step === "parties" && (
        <div style={{ display: "grid", gap: "1rem" }}>
          <div className="field">
            <label htmlFor="acting-identity">Acting as</label>
            <select
              id="acting-identity"
              value={actingProfile ? `${actingProfile.kind}:${actingProfile.personalProfileId ?? actingProfile.businessProfileId}` : ""}
              onChange={(event) => {
                const found = profiles.find(
                  (p) => `${p.kind}:${p.personalProfileId ?? p.businessProfileId}` === event.target.value,
                );
                setActingProfile(found ?? null);
              }}
            >
              {profiles.map((p) => (
                <option key={`${p.kind}:${p.personalProfileId ?? p.businessProfileId}`} value={`${p.kind}:${p.personalProfileId ?? p.businessProfileId}`}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>

          {relationships.length === 0 ? (
            <div className="empty-state">
              <h3>No eligible connections</h3>
              {hasAnyConnections ? (
                <p>
                  Your existing connections aren&apos;t ready for a new agreement yet — an invitation may
                  still be waiting on the other person to accept, or the connection has been closed. Check{" "}
                  <a href="/connections">Connections</a>, or <a href="/connections/invite">invite a counterparty</a>.
                </p>
              ) : (
                <p>
                  You need an active connection with a counterparty before creating an agreement.{" "}
                  <a href="/connections/invite">Invite a counterparty</a> first.
                </p>
              )}
            </div>
          ) : (
            <div className="field">
              <label htmlFor="relationship-picker">Connection</label>
              <select
                id="relationship-picker"
                value={selectedRelationshipId}
                onChange={(event) => void handleSelectRelationship(event.target.value)}
              >
                <option value="">Select a connection…</option>
                {relationships.map((r) => {
                  const chip = relationshipStatusLabel(r.status as Parameters<typeof relationshipStatusLabel>[0]);
                  return (
                    <option key={r.id} value={r.id}>
                      {r.id.slice(0, 8)} — {chip.label}
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {partyError && (
            <p className="form-status form-status--error" role="alert">
              {partyError}
            </p>
          )}

          {counterparty && myRole && (
            <div className="confirm-banner">
              You are <strong>{partyRoleLabel(myRole)}</strong>; the counterparty is{" "}
              <strong>{partyRoleLabel(counterparty.role)}</strong> ({counterparty.kind} party).
            </div>
          )}

          <div className="dialog__actions" style={{ justifyContent: "flex-start" }}>
            <button type="button" className="button button--primary" disabled={!counterparty} onClick={() => setStep("terms")}>
              Next: Terms
            </button>
          </div>
        </div>
      )}

      {step === "terms" && (
        <form
          style={{ display: "grid", gap: "1rem" }}
          onSubmit={(event) => {
            event.preventDefault();
            setStep("review");
          }}
        >
          <AgreementTermsFields values={terms} onChange={(patch) => setTerms((prev) => ({ ...prev, ...patch }))} />
          <div className="dialog__actions" style={{ justifyContent: "flex-start" }}>
            <button type="button" className="button button--ghost" onClick={() => setStep("parties")}>
              Back
            </button>
            <button type="submit" className="button button--primary">
              Next: Review
            </button>
          </div>
        </form>
      )}

      {step === "review" && counterparty && myRole && (
        <div style={{ display: "grid", gap: "1rem" }}>
          <div className="card">
            <p style={{ margin: 0 }}>
              <strong>You are:</strong> {partyRoleLabel(myRole)}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Category:</strong> {terms.category}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Original amount:</strong> {formatMoney(terms.originalAmountMinorUnits)}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Installments:</strong> {formatMoney(terms.installmentAmountMinorUnits)} {terms.frequency}, starting{" "}
              {terms.firstPaymentDate}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Fee allocation:</strong> {feeAllocationLabel(terms.feeAllocation)}
            </p>
          </div>
          {submitError && (
            <p className="form-status form-status--error" role="alert">
              {submitError}
            </p>
          )}
          <div className="dialog__actions" style={{ justifyContent: "flex-start" }}>
            <button type="button" className="button button--ghost" onClick={() => setStep("terms")} disabled={submitting}>
              Back
            </button>
            <button type="button" className="button button--primary" onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting ? "Creating…" : "Create draft agreement"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
