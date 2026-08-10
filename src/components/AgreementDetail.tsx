"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  AgreementTermsFields,
  type AgreementTermsFormValues,
} from "./AgreementTermsFields";
import type { SelectableProfile } from "./ProfileSwitcher";

interface AgreementTerms {
  category: string;
  description: string;
  originalAmountMinorUnits: number;
  previousPaymentsMinorUnits: number;
  currentPrincipalMinorUnits: number;
  firstPaymentMinorUnits: number;
  installmentAmountMinorUnits: number;
  firstPaymentDate: string;
  finalPaymentMinorUnits: number;
  numberOfInstallments: number;
  earlyPayoffTerms: string;
  hardshipRules: string;
  partialPaymentRules: string;
  settlementRules: string;
  disputeProcedure: string;
}

interface ScheduleItem {
  sequenceNumber: number;
  dueDate: string;
  amountMinorUnits: number;
}

interface AgreementDetailData {
  id: string;
  status: string;
  currency: string;
  relationshipShape: "P2P" | "B2C" | "C2B" | "B2B";
  creditor: { kind: "personal" | "business"; id: string };
  debtor: { kind: "personal" | "business"; id: string };
  version: {
    id: string;
    versionNumber: number;
    frequency: "weekly" | "biweekly" | "monthly";
    feeAllocation: "creditor_pays" | "debtor_pays" | "split_evenly";
    terms: AgreementTerms;
    creditorSignedAt: string | null;
    debtorSignedAt: string | null;
    signedAt: string | null;
    documentHash: string | null;
  };
  schedule: ScheduleItem[];
}

type LoadStatus = "loading" | "ready" | "unauthorized" | "error";
type ActionStatus = "idle" | "working" | "error";

function formatDollars(minorUnits: number): string {
  return `$${(minorUnits / 100).toFixed(2)}`;
}

function activeProfileRef(profile: SelectableProfile): { kind: "personal" | "business"; id: string } | null {
  if (profile.kind === "personal") {
    return profile.personalProfileId ? { kind: "personal", id: profile.personalProfileId } : null;
  }
  return profile.businessProfileId ? { kind: "business", id: profile.businessProfileId } : null;
}

/**
 * Sprint 5 functional UI: agreement detail + status-appropriate actions. Which buttons are shown is
 * only a UX hint from comparing the active profile to creditor/debtor — the server re-checks real
 * authorization on every action (AgreementService.authorizeParty), so a wrong guess here just hides
 * or shows a button; it never grants access.
 */
export function AgreementDetail() {
  const agreementId = useSearchParams().get("id");
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [data, setData] = useState<AgreementDetailData | null>(null);
  const [active, setActive] = useState<SelectableProfile | null>(null);
  const [actionStatus, setActionStatus] = useState<ActionStatus>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCounterForm, setShowCounterForm] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [counterTerms, setCounterTerms] = useState<AgreementTermsFormValues | null>(null);

  const load = useCallback(async () => {
    if (!agreementId) {
      setLoadStatus("error");
      return;
    }
    const [detailResponse, activeResponse] = await Promise.all([
      fetch(`/api/agreements/detail?id=${encodeURIComponent(agreementId)}`),
      fetch("/api/profiles/active"),
    ]);
    if (detailResponse.status === 401 || activeResponse.status === 401) {
      setLoadStatus("unauthorized");
      return;
    }
    if (!detailResponse.ok || !activeResponse.ok) {
      setLoadStatus("error");
      return;
    }
    const detail = (await detailResponse.json()) as AgreementDetailData;
    setData(detail);
    setActive((await activeResponse.json()) as SelectableProfile);
    setLoadStatus("ready");
  }, [agreementId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await load();
      } catch {
        if (!cancelled) setLoadStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function runAction(request: () => Promise<Response>) {
    setActionStatus("working");
    setActionError(null);
    const response = await request();
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setActionError(body?.message ?? "That action could not be completed.");
      setActionStatus("error");
      return;
    }
    setActionStatus("idle");
    await load();
  }

  if (loadStatus === "loading") return <p role="status">Loading agreement…</p>;

  if (loadStatus === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert" style={{ maxWidth: "28rem" }}>
        You need to <a href="/login">sign in</a> to view this agreement.
      </p>
    );
  }

  if (loadStatus === "error" || !data) {
    return (
      <p className="form-status form-status--error" role="alert" style={{ maxWidth: "28rem" }}>
        Something went wrong loading this agreement. Please try again.
      </p>
    );
  }

  const me = active ? activeProfileRef(active) : null;
  const iAmCreditor = !!me && me.kind === data.creditor.kind && me.id === data.creditor.id;
  const iAmDebtor = !!me && me.kind === data.debtor.kind && me.id === data.debtor.id;
  const { terms } = data.version;

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "40rem" }}>
      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>
          {data.relationshipShape} — {data.status.replaceAll("_", " ")}
        </h2>
        <p style={{ margin: 0 }}>
          <strong>{terms.category}</strong> — {terms.description}
        </p>
        <p style={{ margin: 0 }}>Original amount: {formatDollars(terms.originalAmountMinorUnits)}</p>
        <p style={{ margin: 0 }}>Previous payments: {formatDollars(terms.previousPaymentsMinorUnits)}</p>
        <p style={{ margin: 0 }}>Current principal: {formatDollars(terms.currentPrincipalMinorUnits)}</p>
        <p style={{ margin: 0 }}>
          First payment: {formatDollars(terms.firstPaymentMinorUnits)} on {terms.firstPaymentDate}
        </p>
        <p style={{ margin: 0 }}>
          {data.version.frequency} installments of {formatDollars(terms.installmentAmountMinorUnits)} (
          {terms.numberOfInstallments} remaining, final payment {formatDollars(terms.finalPaymentMinorUnits)})
        </p>
        <p style={{ margin: 0 }}>Fee allocation: {data.version.feeAllocation.replaceAll("_", " ")}</p>
        <p style={{ margin: 0 }}>
          Signed — creditor: {data.version.creditorSignedAt ? "yes" : "no"}, debtor:{" "}
          {data.version.debtorSignedAt ? "yes" : "no"}
        </p>
      </div>

      <div className="early-access-form">
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Payment schedule</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>#</th>
              <th style={{ textAlign: "left" }}>Due date</th>
              <th style={{ textAlign: "left" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.schedule.map((item) => (
              <tr key={item.sequenceNumber}>
                <td>{item.sequenceNumber === 0 ? "First payment" : item.sequenceNumber}</td>
                <td>{item.dueDate}</td>
                <td>{formatDollars(item.amountMinorUnits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {actionError ? (
        <p className="form-status form-status--error" role="alert">
          {actionError}
        </p>
      ) : null}

      {data.status === "draft" ? (
        <div className="hero__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={actionStatus === "working"}
            onClick={() =>
              void runAction(() =>
                fetch("/api/agreements/submit", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ agreementId: data.id }),
                }),
              )
            }
          >
            Submit for debtor acknowledgment
          </button>
        </div>
      ) : null}

      {data.status === "awaiting_debtor_acknowledgment" ? (
        <div className="hero__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={actionStatus === "working"}
            onClick={() =>
              void runAction(() =>
                fetch("/api/agreements/acknowledge", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ agreementId: data.id }),
                }),
              )
            }
          >
            I acknowledge this obligation is owed
          </button>
        </div>
      ) : null}

      {data.status === "awaiting_creditor_acceptance" && !showCounterForm ? (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          <div className="hero__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={actionStatus === "working"}
              onClick={() =>
                void runAction(() =>
                  fetch("/api/agreements/decide", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ agreementId: data.id, decision: "accept" }),
                  }),
                )
              }
            >
              Accept
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={actionStatus === "working"}
              onClick={() =>
                void runAction(() =>
                  fetch("/api/agreements/decide", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ agreementId: data.id, decision: "reject", reason: rejectReason || undefined }),
                  }),
                )
              }
            >
              Reject
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                setCounterTerms({
                  category: terms.category,
                  description: terms.description,
                  originalAmountMinorUnits: terms.originalAmountMinorUnits,
                  previousPaymentsMinorUnits: terms.previousPaymentsMinorUnits,
                  firstPaymentMinorUnits: terms.firstPaymentMinorUnits,
                  installmentAmountMinorUnits: terms.installmentAmountMinorUnits,
                  frequency: data.version.frequency,
                  firstPaymentDate: terms.firstPaymentDate,
                  feeAllocation: data.version.feeAllocation,
                  earlyPayoffTerms: terms.earlyPayoffTerms,
                  hardshipRules: terms.hardshipRules,
                  partialPaymentRules: terms.partialPaymentRules,
                  settlementRules: terms.settlementRules,
                  disputeProcedure: terms.disputeProcedure,
                });
                setShowCounterForm(true);
              }}
            >
              Counter with new terms
            </button>
          </div>
          <div className="field" style={{ maxWidth: "24rem" }}>
            <label htmlFor="reject-reason">Reason for rejecting (optional)</label>
            <input id="reject-reason" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} />
          </div>
        </div>
      ) : null}

      {data.status === "awaiting_creditor_acceptance" && showCounterForm && counterTerms ? (
        <form
          className="early-access-form"
          onSubmit={(event) => {
            event.preventDefault();
            void runAction(() =>
              fetch("/api/agreements/decide", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ agreementId: data.id, decision: "counter", counterTerms }),
              }),
            ).then(() => setShowCounterForm(false));
          }}
        >
          <AgreementTermsFields values={counterTerms} onChange={(patch) => setCounterTerms((v) => (v ? { ...v, ...patch } : v))} />
          <div className="hero__actions">
            <button type="submit" className="button button--primary" disabled={actionStatus === "working"}>
              Send counterproposal
            </button>
            <button type="button" className="button button--ghost" onClick={() => setShowCounterForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {data.status === "awaiting_signatures" ? (
        (() => {
          const alreadySigned = (iAmCreditor && !!data.version.creditorSignedAt) || (iAmDebtor && !!data.version.debtorSignedAt);
          return (
            <div style={{ display: "grid", gap: "0.5rem" }}>
              <div className="hero__actions">
                <button type="button" className="button button--primary" disabled aria-disabled="true">
                  {alreadySigned ? "Waiting on the other party to sign" : "Sign this agreement (not yet available)"}
                </button>
              </div>
              {!alreadySigned ? (
                <p className="form-status" style={{ maxWidth: "32rem" }}>
                  Signing now requires a step-up verification challenge (Sprint 6). That challenge
                  flow is not yet built into this screen — use the API directly, or wait for a
                  later phase to add it here.
                </p>
              ) : null}
            </div>
          );
        })()
      ) : null}
    </div>
  );
}
