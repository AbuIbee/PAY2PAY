"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  AgreementTermsFields,
  BLANK_AGREEMENT_TERMS,
  type AgreementTermsFormValues,
} from "./AgreementTermsFields";
import { StepUpChallenge } from "./StepUpChallenge";
import { AgreementProgress } from "./AgreementProgress";
import type { AgreementProgress as AgreementProgressData } from "@/lib/agreements/agreementProgressService";
import type { SelectableProfile } from "./ProfileSwitcher";
import { apiFetch, ApiError, isScheduleRevisionRequired } from "@/lib/ui/apiFetch";
import { useStepUpGuardedAction } from "@/lib/ui/useStepUpGuardedAction";
import { formatMoney } from "@/lib/ui/money";
import { formatDate, formatDateTime } from "@/lib/ui/date";
import {
  agreementStatusLabel,
  amendmentStatusLabel,
  amendmentChangeTypeLabel,
  partialPaymentRequestStatusLabel,
  settlementProposalStatusLabel,
  agreementDisputeStatusLabel,
  feeAllocationLabel,
  type ChipTone,
} from "@/lib/ui/statusLabels";

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

interface NextPaymentData {
  nextInstallment: { id: string; sequenceNumber: number; dueDate: string; amountMinorUnits: number } | null;
  remainingBalanceMinorUnits: number | null;
  fundingAccountLabel: string | null;
  recipientDisplayName: string | null;
}

interface WitnessViewData {
  agreement: { id: string; status: string; currency: string };
  version: { id: string; versionNumber: number; terms: AgreementTerms; signedAt: string | null };
  schedule: ScheduleItem[];
}

interface EvidenceItem {
  id: string;
  documentType: string;
  description: string | null;
  isPostSigning: boolean;
  visibility: "shared" | "private";
  sharedWithWitnesses: boolean;
  disputeFlag: boolean;
  withdrawalState: "active" | "withdrawn";
  uploadedAt: string;
}

interface WitnessItem {
  id: string;
  witnessUserId: string;
  addedAt: string;
  attestedAt: string | null;
}

interface AmendmentItem {
  id: string;
  changeType: string;
  status: string;
  proposingPartyRole: "creditor" | "debtor";
  reason: string;
  requestedRelief: string | null;
  proposedEffectiveDate: string | null;
  terms: AgreementTerms;
  frequency: "weekly" | "biweekly" | "monthly";
  feeAllocation: "creditor_pays" | "debtor_pays" | "split_evenly";
  creditorSignedAt: string | null;
  debtorSignedAt: string | null;
  resultingVersionId: string | null;
  createdAt: string;
}

interface AmendmentPreviewData {
  schedule: ScheduleItem[];
  finalPaymentMinorUnits: number;
  numberOfInstallments: number;
}

interface PartialPaymentItem {
  id: string;
  status: string;
  proposingPartyRole: "creditor" | "debtor";
  proposedAmountMinorUnits: number;
  proposedDate: string;
  explanation: string | null;
  createdAt: string;
}

interface SettlementItem {
  id: string;
  status: string;
  proposingPartyRole: "creditor" | "debtor";
  preSettlementBalanceMinorUnits: number;
  settlementAmountMinorUnits: number;
  forgivenAmountMinorUnits: number;
  deadline: string;
  paymentMode: "one_time" | "scheduled";
  completedAt: string | null;
  createdAt: string;
}

interface DisputeItem {
  id: string;
  status: string;
  category: string;
  explanation: string;
  raisedByRole: "creditor" | "debtor";
  response: string | null;
  resolutionNotes: string | null;
  restrictedReason: string | null;
  restrictionLiftedAt: string | null;
  createdAt: string;
}

/** Mutual cancellation (mandatory command): mirrors AgreementCancellationService's own record shape. */
interface CancellationRequestItem {
  id: string;
  status: "pending" | "accepted" | "rejected";
  requestedByPartyRole: "creditor" | "debtor";
  reason: string;
  rejectedReason: string | null;
  createdAt: string;
}

/** Agreement Lifecycle V2 (Part 5 — version history): mirrors AgreementService.listVersionHistory's own shape. */
interface VersionHistoryItem {
  id: string;
  versionNumber: number;
  parentVersionId: string | null;
  isOriginal: boolean;
  producedBy: string;
  creditorSignedAt: string | null;
  debtorSignedAt: string | null;
  signedAt: string | null;
  createdAt: string;
}

function versionProducedByLabel(producedBy: string): string {
  switch (producedBy) {
    case "initial_signing":
      return "Original terms";
    case "debtor_revision":
      return "Revised by debtor";
    case "creditor_revision":
      return "Revised by creditor";
    case "first_payment_date_revision":
      return "First payment date revised";
    default:
      return producedBy.replace(/_/g, " ");
  }
}

type LoadStatus = "loading" | "ready" | "witness" | "unauthorized" | "error";
type ActionStatus = "idle" | "working" | "error";

function activeProfileRef(profile: SelectableProfile): { kind: "personal" | "business"; id: string } | null {
  if (profile.kind === "personal") {
    return profile.personalProfileId ? { kind: "personal", id: profile.personalProfileId } : null;
  }
  return profile.businessProfileId ? { kind: "business", id: profile.businessProfileId } : null;
}

function Chip({ label, tone }: { label: string; tone: ChipTone }) {
  return <span className={`chip chip--${tone}`}>{label}</span>;
}

/**
 * Sprint 5/6/7/14/15/16 functional UI: agreement detail + every status-appropriate action across
 * the agreement's full lifecycle. Which buttons are shown is only a UX hint from comparing the
 * active profile to creditor/debtor — the server re-checks real authorization on every action, so a
 * wrong guess here just hides or shows a button; it never grants access. A user who is a witness
 * (not a party) falls back to the restricted witness view (Sprint 7) instead of the full detail.
 */
export function AgreementDetail() {
  const router = useRouter();
  const agreementId = useSearchParams().get("id");
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [data, setData] = useState<AgreementDetailData | null>(null);
  const [witnessData, setWitnessData] = useState<WitnessViewData | null>(null);
  const [active, setActive] = useState<SelectableProfile | null>(null);
  const [actionStatus, setActionStatus] = useState<ActionStatus>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCounterForm, setShowCounterForm] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [counterTerms, setCounterTerms] = useState<AgreementTermsFormValues | null>(null);
  const [showDebtorReviseForm, setShowDebtorReviseForm] = useState(false);
  const [debtorReviseTerms, setDebtorReviseTerms] = useState<AgreementTermsFormValues | null>(null);
  const [debtorReviseReason, setDebtorReviseReason] = useState("");
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [deleteStatus, setDeleteStatus] = useState<"idle" | "working" | "error">("idle");

  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [witnesses, setWitnesses] = useState<WitnessItem[]>([]);
  const [amendments, setAmendments] = useState<AmendmentItem[]>([]);
  const [partialPayments, setPartialPayments] = useState<PartialPaymentItem[]>([]);
  const [settlements, setSettlements] = useState<SettlementItem[]>([]);
  const [disputes, setDisputes] = useState<DisputeItem[]>([]);
  const [cancellationRequests, setCancellationRequests] = useState<CancellationRequestItem[]>([]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<AgreementProgressData | null>(null);
  const [nextPayment, setNextPayment] = useState<NextPaymentData | null>(null);
  const [versions, setVersions] = useState<VersionHistoryItem[]>([]);

  const load = useCallback(async () => {
    if (!agreementId) {
      setLoadStatus("error");
      return;
    }
    try {
      const [detail, activeProfile] = await Promise.all([
        apiFetch<AgreementDetailData>(`/api/agreements/detail?id=${encodeURIComponent(agreementId)}`),
        apiFetch<SelectableProfile>("/api/profiles/active"),
      ]);
      setData(detail);
      setActive(activeProfile);
      // Agreement workflow remediation (Problem 3): UX-only — a failure here degrades to no progress
      // panel rather than blocking the rest of the page, matching this file's own established
      // tolerant-fetch pattern for evidence/witnesses/amendments/etc. below.
      apiFetch<AgreementProgressData>(`/api/agreements/progress?id=${encodeURIComponent(agreementId)}`)
        .then((body) => setProgress(Array.isArray(body?.steps) ? body : null))
        .catch(() => setProgress(null));
      // Restore agreement payment functionality: same tolerant-fetch pattern as progress above — a
      // failure here just hides the Make Payment section rather than blocking the rest of the page.
      apiFetch<NextPaymentData>(`/api/agreements/payment-setup/next-payment?id=${encodeURIComponent(agreementId)}`)
        .then(setNextPayment)
        .catch(() => setNextPayment(null));
      const [evidenceRes, witnessRes, amendmentRes, partialRes, settlementRes, disputeRes, versionsRes, cancellationRes] = await Promise.all([
        apiFetch<{ evidence: EvidenceItem[] }>(`/api/agreements/evidence?agreementId=${agreementId}`).catch(() => ({ evidence: [] })),
        apiFetch<{ witnesses: WitnessItem[] }>(`/api/agreements/witnesses?agreementId=${agreementId}`).catch(() => ({ witnesses: [] })),
        apiFetch<{ amendments: AmendmentItem[] }>(`/api/agreements/amendments?agreementId=${agreementId}`).catch(() => ({ amendments: [] })),
        apiFetch<{ requests: PartialPaymentItem[] }>(`/api/agreements/partial-payments?agreementId=${agreementId}`).catch(() => ({ requests: [] })),
        apiFetch<{ proposals: SettlementItem[] }>(`/api/agreements/settlements?agreementId=${agreementId}`).catch(() => ({ proposals: [] })),
        apiFetch<{ disputes: DisputeItem[] }>(`/api/agreements/disputes?agreementId=${agreementId}`).catch(() => ({ disputes: [] })),
        apiFetch<{ versions: VersionHistoryItem[] }>(`/api/agreements/versions?agreementId=${agreementId}`).catch(() => ({ versions: [] })),
        apiFetch<{ requests: CancellationRequestItem[] }>(`/api/agreements/cancellation-requests?agreementId=${agreementId}`).catch(() => ({ requests: [] })),
      ]);
      setEvidence(evidenceRes.evidence);
      setWitnesses(witnessRes.witnesses);
      setAmendments(amendmentRes.amendments);
      setPartialPayments(partialRes.requests);
      setSettlements(settlementRes.proposals);
      setDisputes(disputeRes.disputes);
      setVersions(versionsRes.versions ?? []);
      setCancellationRequests(cancellationRes.requests ?? []);
      setLoadStatus("ready");
    } catch (error) {
      if (error instanceof ApiError && error.httpStatus === 401) {
        setLoadStatus("unauthorized");
        return;
      }
      if (error instanceof ApiError && error.httpStatus === 403) {
        try {
          const view = await apiFetch<WitnessViewData>(`/api/agreements/witnesses/view?agreementId=${agreementId}`);
          setWitnessData(view);
          setLoadStatus("witness");
          return;
        } catch {
          setLoadStatus("error");
          return;
        }
      }
      setLoadStatus("error");
    }
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

  async function runAction(request: () => Promise<unknown>) {
    setActionStatus("working");
    setActionError(null);
    try {
      await request();
      setActionStatus("idle");
      await load();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "That action could not be completed.");
      setActionStatus("error");
    }
  }

  async function handleDeleteDraft() {
    if (!data) return;
    if (!window.confirm("Delete this draft agreement? It has not been sent or executed. This cannot be undone.")) return;
    setDeleteStatus("working");
    setActionError(null);
    try {
      await apiFetch("/api/agreements/delete-draft", { method: "POST", body: JSON.stringify({ agreementId: data.id }) });
      router.push("/agreements");
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "This draft could not be deleted.");
      setDeleteStatus("error");
    }
  }

  const signAction = useStepUpGuardedAction(async (authMethod: "totp" | "sms") => {
    if (!data) throw new Error("no data");
    return apiFetch(`/api/agreements/sign`, {
      method: "POST",
      body: JSON.stringify({
        agreementId: data.id,
        authMethod,
        consentVersion: "v1",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
  });

  const settlementDecideAction = useStepUpGuardedAction(
    async (input: { settlementProposalId: string; decision: "accept" | "reject" | "counter" }) =>
      apiFetch("/api/agreements/settlements/decide", { method: "POST", body: JSON.stringify(input) }),
  );
  const settlementProposeAction = useStepUpGuardedAction(async (input: Record<string, unknown>) =>
    apiFetch("/api/agreements/settlements/propose", { method: "POST", body: JSON.stringify(input) }),
  );

  async function handleViewPdf() {
    if (!data) return;
    try {
      const body = await apiFetch<{ signedUrl: string }>(`/api/agreements/pdf?id=${data.id}`);
      setPdfUrl(body.signedUrl);
    } catch {
      setActionError("The signed PDF isn't available yet.");
    }
  }

  if (loadStatus === "loading") return <p role="status">Loading agreement…</p>;

  if (loadStatus === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert" style={{ maxWidth: "28rem" }}>
        You need to <a href="/login">sign in</a> to view this agreement.
      </p>
    );
  }

  if (loadStatus === "witness" && witnessData) {
    return (
      <div style={{ display: "grid", gap: "1.5rem", maxWidth: "40rem" }}>
        <div className="card">
          <div className="card__header">
            <h2>Witness view</h2>
            <Chip {...agreementStatusLabel(witnessData.agreement.status as Parameters<typeof agreementStatusLabel>[0])} />
          </div>
          <p style={{ margin: 0, color: "var(--ink-soft)" }}>
            You are viewing this agreement as a witness. Financial account and identity details are never shown here.
          </p>
          <p style={{ margin: "0.75rem 0 0" }}>
            <strong>{witnessData.version.terms.category}</strong> — {formatMoney(witnessData.version.terms.originalAmountMinorUnits)}
          </p>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Due date</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {witnessData.schedule.map((item) => (
                <tr key={item.sequenceNumber}>
                  <td>{item.sequenceNumber === 0 ? "First payment" : item.sequenceNumber}</td>
                  <td>{formatDate(item.dueDate)}</td>
                  <td>{formatMoney(item.amountMinorUnits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {witnesses.length === 0 ? null : (
          <WitnessAttestPanel agreementId={witnessData.agreement.id} onDone={() => void load()} />
        )}
      </div>
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
  const myRole: "creditor" | "debtor" | null = iAmCreditor ? "creditor" : iAmDebtor ? "debtor" : null;
  const { terms } = data.version;
  const isSignedOrLater = !["draft", "awaiting_debtor_acknowledgment", "awaiting_creditor_acceptance", "awaiting_signatures"].includes(
    data.status,
  );

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "44rem" }}>
      <div className="card">
        <div className="card__header">
          <h2>{data.relationshipShape}</h2>
          <Chip {...agreementStatusLabel(data.status as Parameters<typeof agreementStatusLabel>[0])} />
        </div>
        <p style={{ margin: 0 }}>
          <strong>{terms.category}</strong> — {terms.description}
        </p>
        <p style={{ margin: "0.4rem 0 0" }}>Original amount: {formatMoney(terms.originalAmountMinorUnits)}</p>
        <p style={{ margin: 0 }}>Previous payments: {formatMoney(terms.previousPaymentsMinorUnits)}</p>
        <p style={{ margin: 0 }}>Current principal: {formatMoney(terms.currentPrincipalMinorUnits)}</p>
        <p style={{ margin: 0 }}>
          First payment: {formatMoney(terms.firstPaymentMinorUnits)} on {formatDate(terms.firstPaymentDate)}
        </p>
        <p style={{ margin: 0 }}>
          {data.version.frequency} installments of {formatMoney(terms.installmentAmountMinorUnits)} (
          {terms.numberOfInstallments} remaining, final payment {formatMoney(terms.finalPaymentMinorUnits)})
        </p>
        <p style={{ margin: 0 }}>Fee allocation: {feeAllocationLabel(data.version.feeAllocation)}</p>
        <button
          type="button"
          className="button button--ghost"
          style={{ marginTop: "0.75rem", marginRight: "0.5rem" }}
          onClick={() => window.open(`/api/agreements/pdf/preview?id=${data.id}`, "_blank", "noopener,noreferrer")}
        >
          Print / PDF
        </button>
        {isSignedOrLater && (
          <button type="button" className="button button--ghost" style={{ marginTop: "0.75rem" }} onClick={() => void handleViewPdf()}>
            View signed PDF
          </button>
        )}
        {pdfUrl && (
          <p style={{ marginTop: "0.5rem" }}>
            <a href={pdfUrl} target="_blank" rel="noreferrer">
              Open PDF (link expires shortly)
            </a>
          </p>
        )}
      </div>

      {progress && <AgreementProgress data={progress} />}

      {progress?.steps.find((s) => s.key === "payment_method")?.status === "blocked" && (
        <MissingConnectionPanel agreementId={data.id} onLinked={() => void load()} />
      )}

      {myRole === "debtor" &&
        progress?.steps.find((s) => s.key === "payment_method")?.status === "complete" &&
        nextPayment?.nextInstallment && (
          <MakePaymentPanel
            agreementId={data.id}
            currency={data.currency}
            payer={data.debtor}
            recipient={data.creditor}
            nextInstallment={nextPayment.nextInstallment}
            remainingBalanceMinorUnits={nextPayment.remainingBalanceMinorUnits}
            fundingAccountLabel={nextPayment.fundingAccountLabel}
            recipientDisplayName={nextPayment.recipientDisplayName}
            onSubmitted={() => void load()}
          />
        )}

      <div className="card">
        <div className="card__header">
          <h3>Payment schedule</h3>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Due date</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.schedule.map((item) => (
                <tr key={item.sequenceNumber}>
                  <td>{item.sequenceNumber === 0 ? "First payment" : item.sequenceNumber}</td>
                  <td>{formatDate(item.dueDate)}</td>
                  <td>{formatMoney(item.amountMinorUnits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Agreement page ordering remediation: Amendments modifies the agreement itself, so it must
          appear before supporting Evidence & witnesses material — both moved here, directly after
          the payment schedule, ahead of version history/status-action sections. */}
      <AmendmentPanel
        agreementId={data.id}
        amendments={amendments}
        myRole={myRole}
        currentTerms={terms}
        currentFrequency={data.version.frequency}
        currentFeeAllocation={data.version.feeAllocation}
        currentSchedule={data.schedule}
        currency={data.currency}
        onChanged={() => void load()}
      />

      <EvidenceWitnessPanel
        agreementId={data.id}
        evidence={evidence}
        witnesses={witnesses}
        onChanged={() => void load()}
      />

      {versions.length > 1 && (
        <div className="card">
          <div className="card__header">
            <h3>Version history</h3>
          </div>
          <div className="table-wrap table-wrap--responsive-cards">
            <table className="table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Change</th>
                  <th>Created</th>
                  <th>Signatures</th>
                </tr>
              </thead>
              <tbody>
                {[...versions]
                  .sort((a, b) => b.versionNumber - a.versionNumber)
                  .map((v) => (
                    <tr key={v.id}>
                      <td data-label="Version">
                        v{v.versionNumber}
                        {v.id === data.version.id ? " (current)" : ""}
                      </td>
                      <td data-label="Change">{versionProducedByLabel(v.producedBy)}</td>
                      <td data-label="Created">{formatDateTime(v.createdAt)}</td>
                      <td data-label="Signatures">
                        {v.signedAt ? (
                          "Fully signed"
                        ) : v.creditorSignedAt || v.debtorSignedAt ? (
                          "Partially signed"
                        ) : (
                          "Not signed"
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {actionError && (
        <p className="form-status form-status--error" role="alert">
          {actionError}
        </p>
      )}

      {data.status === "draft" && (
        <div className="hero__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={actionStatus === "working"}
            onClick={() => void runAction(() => apiFetch("/api/agreements/submit", { method: "POST", body: JSON.stringify({ agreementId: data.id }) }))}
          >
            Submit for debtor acknowledgment
          </button>
          <button type="button" className="button button--ghost" disabled={deleteStatus === "working"} onClick={() => void handleDeleteDraft()}>
            {deleteStatus === "working" ? "Deleting…" : "Delete Draft"}
          </button>
        </div>
      )}

      {["awaiting_debtor_acknowledgment", "awaiting_creditor_acceptance", "awaiting_signatures"].includes(data.status) && !showCancelForm && (
        <div style={{ marginTop: "-0.5rem" }}>
          <button type="button" className="button button--ghost" onClick={() => setShowCancelForm(true)}>
            Cancel Agreement
          </button>
        </div>
      )}

      {["awaiting_debtor_acknowledgment", "awaiting_creditor_acceptance", "awaiting_signatures"].includes(data.status) && showCancelForm && (
        <div className="card" role="alertdialog" aria-labelledby="cancel-agreement-heading">
          <h3 id="cancel-agreement-heading" style={{ marginTop: 0 }}>
            Cancel this agreement?
          </h3>
          <p style={{ color: "var(--ink-soft)" }}>
            This agreement has not been fully executed. Cancelling it will prevent either party from continuing the
            current agreement. The historical record will be retained.
          </p>
          <div className="field">
            <label htmlFor="cancel-reason">Reason (required)</label>
            <input id="cancel-reason" value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} />
          </div>
          <div className="hero__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={actionStatus === "working" || !cancelReason.trim()}
              onClick={() =>
                void runAction(() =>
                  apiFetch("/api/agreements/cancel", { method: "POST", body: JSON.stringify({ agreementId: data.id, reason: cancelReason }) }),
                ).then(() => {
                  setShowCancelForm(false);
                  setCancelReason("");
                })
              }
            >
              Confirm Cancellation
            </button>
            <button type="button" className="button button--ghost" onClick={() => setShowCancelForm(false)}>
              Never mind
            </button>
          </div>
        </div>
      )}

      {data.status === "awaiting_debtor_acknowledgment" && !showDebtorReviseForm && (
        <div className="hero__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={actionStatus === "working"}
            onClick={() => void runAction(() => apiFetch("/api/agreements/acknowledge", { method: "POST", body: JSON.stringify({ agreementId: data.id }) }))}
          >
            I acknowledge this obligation is owed
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              setDebtorReviseTerms({
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
              setShowDebtorReviseForm(true);
            }}
          >
            Request changes
          </button>
        </div>
      )}

      {data.status === "awaiting_debtor_acknowledgment" && showDebtorReviseForm && debtorReviseTerms && (
        <form
          className="card"
          onSubmit={(event) => {
            event.preventDefault();
            void runAction(() =>
              apiFetch("/api/agreements/revise-terms", {
                method: "POST",
                body: JSON.stringify({ agreementId: data.id, newTerms: debtorReviseTerms, reason: debtorReviseReason }),
              }),
            ).then(() => {
              setShowDebtorReviseForm(false);
              setDebtorReviseReason("");
            });
          }}
        >
          <div className="field">
            <label htmlFor="debtor-revise-reason">Why are you requesting changes?</label>
            <input
              id="debtor-revise-reason"
              value={debtorReviseReason}
              onChange={(event) => setDebtorReviseReason(event.target.value)}
              required
            />
          </div>
          <AgreementTermsFields values={debtorReviseTerms} onChange={(patch) => setDebtorReviseTerms((v) => (v ? { ...v, ...patch } : v))} />
          <div className="hero__actions">
            <button type="submit" className="button button--primary" disabled={actionStatus === "working" || !debtorReviseReason.trim()}>
              Send requested changes
            </button>
            <button type="button" className="button button--ghost" onClick={() => setShowDebtorReviseForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {data.status === "awaiting_creditor_acceptance" && !showCounterForm && (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          <div className="hero__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={actionStatus === "working"}
              onClick={() => void runAction(() => apiFetch("/api/agreements/decide", { method: "POST", body: JSON.stringify({ agreementId: data.id, decision: "accept" }) }))}
            >
              Accept
            </button>
            <button
              type="button"
              className="button button--ghost"
              disabled={actionStatus === "working"}
              onClick={() => {
                if (!window.confirm("Reject this agreement? This cannot be undone and the other party will be notified.")) return;
                void runAction(() =>
                  apiFetch("/api/agreements/decide", { method: "POST", body: JSON.stringify({ agreementId: data.id, decision: "reject", reason: rejectReason || undefined }) }),
                );
              }}
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
      )}

      {data.status === "awaiting_creditor_acceptance" && showCounterForm && counterTerms && (
        <form
          className="card"
          onSubmit={(event) => {
            event.preventDefault();
            void runAction(() => apiFetch("/api/agreements/decide", { method: "POST", body: JSON.stringify({ agreementId: data.id, decision: "counter", counterTerms }) })).then(() =>
              setShowCounterForm(false),
            );
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
      )}

      {data.status === "awaiting_signatures" && myRole && (
        <SignaturePanel
          agreementId={data.id}
          myRole={myRole}
          creditorSignedAt={data.version.creditorSignedAt}
          debtorSignedAt={data.version.debtorSignedAt}
          signAction={signAction}
          onRevised={() => void load()}
        />
      )}

      <PartialPaymentPanel agreementId={data.id} requests={partialPayments} myRole={myRole} onChanged={() => void load()} />

      <SettlementPanel
        agreementId={data.id}
        proposals={settlements}
        myRole={myRole}
        proposeAction={settlementProposeAction}
        decideAction={settlementDecideAction}
        onChanged={() => void load()}
      />

      <DisputePanel agreementId={data.id} disputes={disputes} onChanged={() => void load()} />

      {["first_payment_pending", "active", "past_due"].includes(data.status) && myRole && (
        <AgreementCancellationPanel agreementId={data.id} myRole={myRole} requests={cancellationRequests} onChanged={() => void load()} />
      )}
    </div>
  );
}

function WitnessAttestPanel({ agreementId, onDone }: { agreementId: string; onDone: () => void }) {
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  return (
    <div className="card">
      <button
        type="button"
        className="button button--primary"
        disabled={status === "working"}
        onClick={() => {
          setStatus("working");
          apiFetch("/api/agreements/witnesses/attest", { method: "POST", body: JSON.stringify({ agreementId }) })
            .then(onDone)
            .catch(() => setStatus("error"));
        }}
      >
        Attest as witness
      </button>
      {status === "error" && (
        <p className="form-status form-status--error" role="alert">
          Could not record your attestation. Please try again.
        </p>
      )}
    </div>
  );
}

function SignaturePanel({
  agreementId,
  myRole,
  creditorSignedAt,
  debtorSignedAt,
  signAction,
  onRevised,
}: {
  agreementId: string;
  myRole: "creditor" | "debtor";
  creditorSignedAt: string | null;
  debtorSignedAt: string | null;
  signAction: ReturnType<typeof useStepUpGuardedAction<["totp" | "sms"], unknown>>;
  onRevised: () => void;
}) {
  const alreadySigned = myRole === "creditor" ? !!creditorSignedAt : !!debtorSignedAt;
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  // Agreement workflow remediation (Problem 2): set instead of `error` when signing fails because the
  // proposed first payment date has already passed — see ScheduleRevisionRequiredError. Replaces the
  // dead-end error text with the actual required resolution: propose a new date, right here.
  const [needsScheduleRevision, setNeedsScheduleRevision] = useState(false);
  const [newDate, setNewDate] = useState("");
  const [revising, setRevising] = useState(false);
  const [reviseError, setReviseError] = useState<string | null>(null);

  async function handleRevise(event: React.FormEvent) {
    event.preventDefault();
    if (!newDate) return;
    setRevising(true);
    setReviseError(null);
    try {
      await apiFetch("/api/agreements/revise-first-payment-date", {
        method: "POST",
        body: JSON.stringify({ agreementId, newFirstPaymentDate: newDate }),
      });
      setNeedsScheduleRevision(false);
      onRevised();
    } catch (e) {
      setReviseError(e instanceof ApiError ? e.message : "Could not update the schedule. Please try again.");
    } finally {
      setRevising(false);
    }
  }

  return (
    <div className="card">
      <div className="card__header">
        <h3>Signature</h3>
      </div>
      <p style={{ margin: 0 }}>Creditor signed: {creditorSignedAt ? formatDateTime(creditorSignedAt) : "not yet"}</p>
      <p style={{ margin: "0.25rem 0 0" }}>Debtor signed: {debtorSignedAt ? formatDateTime(debtorSignedAt) : "not yet"}</p>
      <p className="form-status" style={{ marginTop: "0.75rem" }}>
        By signing, you consent to this agreement&apos;s terms as shown above. A fresh verification challenge may be required.
      </p>

      {needsScheduleRevision ? (
        <form onSubmit={(event) => void handleRevise(event)} style={{ marginTop: "0.75rem", display: "grid", gap: "0.6rem" }}>
          <p className="field-error" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
          <div className="field">
            <label htmlFor="revised-first-payment-date">New first payment date</label>
            <input
              id="revised-first-payment-date"
              type="date"
              required
              value={newDate}
              onChange={(event) => setNewDate(event.target.value)}
            />
          </div>
          {reviseError && (
            <p className="field-error" role="alert">
              {reviseError}
            </p>
          )}
          <div className="hero__actions">
            <button type="submit" className="button button--primary" disabled={revising}>
              {revising ? "Updating…" : "Propose new date"}
            </button>
          </div>
        </form>
      ) : (
        <>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {!alreadySigned ? (
            <button
              type="button"
              className="button button--primary"
              disabled={status === "working"}
              onClick={() => {
                setStatus("working");
                setError(null);
                // Agreement Lifecycle V2: record the signer's *actual* enrolled MFA method as
                // evidence, rather than always claiming "totp" regardless of what they use — a
                // signature_event's authMethod is legally evidentiary (master spec §27), so an
                // SMS-only signer must never be recorded as having authenticated via an
                // authenticator app they don't have.
                apiFetch<{ enrolled: boolean; methods: Array<"totp" | "sms"> }>("/api/auth/mfa/status")
                  .then((mfaStatus) => mfaStatus.methods?.[0] ?? "totp")
                  // Never let this best-effort lookup itself block signing — an unexpected shape or
                  // a transient failure here still lets the real signing attempt proceed (falling
                  // back to "totp"), which is exactly as good as this flow's prior, unconditional
                  // behavior — just no longer *worse* for an SMS-only signer.
                  .catch(() => "totp" as const)
                  .then((authMethod) => signAction.run(authMethod))
                  .then(() => window.location.reload())
                  .catch((e: unknown) => {
                    if (isScheduleRevisionRequired(e)) {
                      setError(e.message);
                      setNeedsScheduleRevision(true);
                      setStatus("idle");
                      return;
                    }
                    setError(e instanceof ApiError ? e.message : "Signing failed. Please try again.");
                    setStatus("idle");
                  });
              }}
            >
              {status === "working" ? "Signing…" : "Sign this agreement"}
            </button>
          ) : (
            <p className="form-status">Waiting on the other party to sign.</p>
          )}
        </>
      )}
      {signAction.isChallengeOpen && (
        <StepUpChallenge
          action="sign_agreement"
          actionDescription="sign this agreement"
          onVerified={signAction.resolveChallenge}
          onCancel={signAction.cancelChallenge}
        />
      )}
    </div>
  );
}

/**
 * Restore agreement payment functionality: the debtor's "Make Payment" action — shows the exact
 * amount that will be charged, the funding source, and the creditor before submission, and never
 * marks a payment complete on click. It shows only whatever real status
 * POST /api/ach/payments/manual returns (scheduled/submitted/processing/...); the actual clearing
 * happens later via the provider webhook (see PaymentWebhookService), so `onSubmitted` reloads the
 * agreement to reflect the real, current status rather than an optimistic one.
 *
 * Fix the "Make payment" button (mandatory command): a first click never submits the payment. The
 * phases are: "review" (this panel's own default state — everything below is already the review:
 * recipient, amount, due date, balance, funding source, rail, fee) -> clicking "Review payment"
 * enters "confirming" (an explicit, final confirmation summary + a distinct "Confirm payment"
 * button, with a "Cancel" escape hatch) -> only "Confirm payment" calls the real payment API.
 */
function MakePaymentPanel({
  agreementId,
  currency,
  payer,
  recipient,
  recipientDisplayName,
  nextInstallment,
  remainingBalanceMinorUnits,
  fundingAccountLabel,
  onSubmitted,
}: {
  agreementId: string;
  currency: string;
  payer: { kind: "personal" | "business"; id: string };
  recipient: { kind: "personal" | "business"; id: string };
  recipientDisplayName: string | null;
  nextInstallment: { id: string; sequenceNumber: number; dueDate: string; amountMinorUnits: number };
  remainingBalanceMinorUnits: number | null;
  fundingAccountLabel: string | null;
  onSubmitted: () => void;
}) {
  const [phase, setPhase] = useState<"review" | "confirming" | "submitting" | "submitted" | "error">("review");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; status: string } | null>(null);
  const recipientLabel = recipientDisplayName ?? "the other party";

  async function handleConfirm() {
    setPhase("submitting");
    setError(null);
    try {
      const body = await apiFetch<{ id: string; status: string }>("/api/ach/payments/manual", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: `agreement-payment-${agreementId}-${nextInstallment.id}-${crypto.randomUUID()}`,
          agreementId,
          payer: { profileKind: payer.kind, profileId: payer.id },
          recipient: { profileKind: recipient.kind, profileId: recipient.id },
          amountMinorUnits: nextInstallment.amountMinorUnits,
          currency,
          installmentScheduleItemId: nextInstallment.id,
        }),
      });
      setResult(body);
      setPhase("submitted");
      onSubmitted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not submit this payment. Please try again.");
      setPhase("error");
    }
  }

  return (
    <div className="card" id="make-payment" aria-labelledby="make-payment-heading">
      <div className="card__header">
        <h3 id="make-payment-heading">Make a payment</h3>
      </div>
      <p style={{ margin: 0 }}>Pay to: {recipientLabel}</p>
      <p style={{ margin: 0 }}>Amount due: {formatMoney(nextInstallment.amountMinorUnits, currency)}</p>
      <p style={{ margin: 0 }}>Due date: {formatDate(nextInstallment.dueDate)}</p>
      {remainingBalanceMinorUnits != null && (
        <p style={{ margin: 0 }}>Remaining balance: {formatMoney(remainingBalanceMinorUnits, currency)}</p>
      )}
      <p style={{ margin: 0 }}>Funding source: {fundingAccountLabel ?? "Not set up"}</p>
      <p style={{ margin: 0 }}>Payment method: ACH bank transfer</p>
      <p style={{ margin: 0 }}>Fee: None — you&apos;ll be charged exactly the amount above</p>
      <p style={{ margin: "0.5rem 0 0", color: "var(--ink-soft)", fontSize: "0.85rem" }}>
        Payments are not collected automatically — you&apos;ll need to submit each payment yourself when it&apos;s due.
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {phase === "submitted" && result ? (
        <p className="form-status" role="status" style={{ marginTop: "0.75rem" }}>
          Payment submitted — status: {result.status.replaceAll("_", " ")}. This page updates once your bank finishes processing it.
        </p>
      ) : phase === "confirming" || phase === "submitting" ? (
        <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.5rem" }}>
          <p className="form-status" role="status" style={{ margin: 0 }}>
            Confirm payment of {formatMoney(nextInstallment.amountMinorUnits, currency)} to {recipientLabel} from{" "}
            {fundingAccountLabel} via ACH bank transfer. This cannot be undone once your bank processes it.
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className="button button--primary"
              disabled={phase === "submitting"}
              onClick={() => void handleConfirm()}
            >
              {phase === "submitting" ? "Submitting…" : "Confirm payment"}
            </button>
            <button type="button" className="button button--ghost" disabled={phase === "submitting"} onClick={() => setPhase("review")}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="button button--primary"
          style={{ marginTop: "0.75rem" }}
          disabled={!fundingAccountLabel}
          onClick={() => setPhase("confirming")}
        >
          Review payment
        </button>
      )}
    </div>
  );
}

interface LinkCandidate {
  id: string;
  status: string;
}

/**
 * Missing-connection remediation (mandatory command): shown whenever Step 3/5's payment_method
 * status reads "blocked" — the truthful state for an agreement with no linked relationship (every
 * agreement created via the "Invite someone" flow, which never links one). Contact support alone was
 * previously the only offered action; this adds the two real, working entry points a user actually
 * needs: creating a brand-new connection, or — when one with the agreement's exact counterparty
 * already exists and isn't governing another agreement — linking it directly via the pre-existing
 * POST /api/relationships/link-agreement (the same call AgreementCreateWizard itself uses).
 */
function MissingConnectionPanel({ agreementId, onLinked }: { agreementId: string; onLinked: () => void }) {
  const [candidates, setCandidates] = useState<LinkCandidate[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [status, setStatus] = useState<"idle" | "linking" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<{ relationships: LinkCandidate[] }>(`/api/agreements/link-candidates?agreementId=${agreementId}`);
        if (!cancelled) setCandidates(body.relationships);
      } catch {
        if (!cancelled) setCandidates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agreementId]);

  async function handleLink() {
    if (!selectedId) return;
    setStatus("linking");
    setError(null);
    try {
      await apiFetch("/api/relationships/link-agreement", {
        method: "POST",
        body: JSON.stringify({ relationshipId: selectedId, agreementId }),
      });
      onLinked();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not link this connection. Please try again.");
      setStatus("idle");
    }
  }

  return (
    <div className="card">
      <div className="card__header">
        <h3>Connection required</h3>
      </div>
      <p style={{ margin: 0 }}>
        This agreement isn&apos;t linked to a connection, so a funding or payout account can&apos;t be assigned yet.
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.75rem", alignItems: "center" }}>
        <a href="/connections/invite" className="button button--primary">
          Create New Connection
        </a>
        {candidates && candidates.length > 0 && (
          <>
            <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} aria-label="Choose an existing connection">
              <option value="">Choose Existing Connection…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id.slice(0, 8)} — {c.status.replaceAll("_", " ")}
                </option>
              ))}
            </select>
            <button type="button" className="button button--ghost" disabled={!selectedId || status === "linking"} onClick={() => void handleLink()}>
              {status === "linking" ? "Linking…" : "Link connection"}
            </button>
          </>
        )}
        <a href="/support" className="button button--ghost">
          Contact support
        </a>
      </div>
    </div>
  );
}

function EvidenceWitnessPanel({
  agreementId,
  evidence,
  witnesses,
  onChanged,
}: {
  agreementId: string;
  evidence: EvidenceItem[];
  witnesses: WitnessItem[];
  onChanged: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState("other");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"shared" | "private">("shared");
  const [uploadStatus, setUploadStatus] = useState<"idle" | "working" | "error">("idle");
  const [witnessUserId, setWitnessUserId] = useState("");
  const [witnessStatus, setWitnessStatus] = useState<"idle" | "working" | "error">("idle");

  async function handleUpload(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setUploadStatus("working");
    const formData = new FormData();
    formData.set("file", file);
    formData.set("agreementId", agreementId);
    formData.set("documentType", documentType);
    formData.set("description", description);
    formData.set("visibility", visibility);
    const response = await fetch("/api/agreements/evidence", { method: "POST", body: formData });
    if (!response.ok) {
      setUploadStatus("error");
      return;
    }
    setUploadStatus("idle");
    setFile(null);
    setDescription("");
    onChanged();
  }

  async function handleAddWitness(event: React.FormEvent) {
    event.preventDefault();
    setWitnessStatus("working");
    try {
      await apiFetch("/api/agreements/witnesses", { method: "POST", body: JSON.stringify({ agreementId, witnessUserId }) });
      setWitnessUserId("");
      setWitnessStatus("idle");
      onChanged();
    } catch {
      setWitnessStatus("error");
    }
  }

  return (
    <div className="card">
      <div className="card__header">
        <h3>Evidence &amp; witnesses</h3>
      </div>

      {evidence.length === 0 ? (
        <p className="form-status">No evidence uploaded yet.</p>
      ) : (
        <div className="table-wrap table-wrap--responsive-cards">
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Visibility</th>
                <th>Uploaded</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((item) => (
                <tr key={item.id}>
                  <td data-label="Type">{item.documentType.replaceAll("_", " ")}</td>
                  <td data-label="Visibility">{item.visibility}</td>
                  <td data-label="Uploaded">
                    {formatDateTime(item.uploadedAt)}
                    {item.isPostSigning ? " (added after signing)" : ""}
                  </td>
                  <td data-label="Flags">
                    {item.disputeFlag ? <Chip label="Flagged for dispute" tone="warning" /> : null}
                    {item.withdrawalState === "withdrawn" ? <Chip label="Withdrawn" tone="neutral" /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={(event) => void handleUpload(event)} style={{ display: "grid", gap: "0.75rem", marginTop: "1rem" }}>
        <div className="early-access-form__row">
          <div className="field">
            <label htmlFor="evidence-type">Document type</label>
            <select id="evidence-type" value={documentType} onChange={(event) => setDocumentType(event.target.value)}>
              {["invoice", "receipt", "contract", "estimate", "purchase_order", "proof_of_delivery", "proof_of_completed_work", "prior_payment_record", "other"].map(
                (t) => (
                  <option key={t} value={t}>
                    {t.replaceAll("_", " ")}
                  </option>
                ),
              )}
            </select>
          </div>
          <div className="field">
            <label htmlFor="evidence-visibility">Visibility</label>
            <select id="evidence-visibility" value={visibility} onChange={(event) => setVisibility(event.target.value as "shared" | "private")}>
              <option value="shared">Shared with counterparty</option>
              <option value="private">Private (only me)</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="evidence-file">File</label>
          <input id="evidence-file" type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required />
        </div>
        <div className="field">
          <label htmlFor="evidence-description">Description (optional)</label>
          <input id="evidence-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} />
        </div>
        {uploadStatus === "error" && (
          <p className="field-error" role="alert">
            Upload failed. Please try again.
          </p>
        )}
        <button type="submit" className="button button--ghost" disabled={!file || uploadStatus === "working"}>
          {uploadStatus === "working" ? "Uploading…" : "Upload evidence"}
        </button>
      </form>

      <div style={{ marginTop: "1.25rem" }}>
        <h4 style={{ margin: "0 0 0.5rem" }}>Witnesses ({witnesses.length}/2)</h4>
        {witnesses.length === 0 ? (
          <p className="form-status">No witnesses added.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {witnesses.map((w) => (
              <li key={w.id}>
                Witness added {formatDate(w.addedAt)} — {w.attestedAt ? `attested ${formatDate(w.attestedAt)}` : "not yet attested"}
              </li>
            ))}
          </ul>
        )}
        {witnesses.length < 2 && (
          <form onSubmit={(event) => void handleAddWitness(event)} style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", alignItems: "flex-end" }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="witness-user-id">Witness&apos;s user ID</label>
              <small>They must already have a PAY2PAY account. Ask them to share their account ID with you.</small>
              <input id="witness-user-id" value={witnessUserId} onChange={(event) => setWitnessUserId(event.target.value)} required />
            </div>
            <button type="submit" className="button button--ghost" disabled={witnessStatus === "working"}>
              Add witness
            </button>
          </form>
        )}
        {witnessStatus === "error" && (
          <p className="field-error" role="alert">
            Could not add this witness. Check the ID and try again.
          </p>
        )}
      </div>
    </div>
  );
}

function frequencyLabel(frequency: "weekly" | "biweekly" | "monthly"): string {
  switch (frequency) {
    case "weekly":
      return "Weekly";
    case "biweekly":
      return "Every two weeks";
    case "monthly":
      return "Monthly";
  }
}

/** One current-vs-proposed row — only rendered distinctly (bolded) when the two values actually differ, so the recipient's eye goes straight to what's changing. */
function ComparisonRow({ label, current, proposed }: { label: string; current: string; proposed: string }) {
  const changed = current !== proposed;
  return (
    <tr>
      <td data-label="Term" style={{ fontWeight: 600 }}>
        {label}
      </td>
      <td data-label="Current">{current}</td>
      <td data-label="Proposed" style={changed ? { fontWeight: 700, color: "var(--gold-strong, #7a5610)" } : undefined}>
        {proposed}
        {changed && (
          <span className="chip chip--warning" style={{ marginLeft: "0.5rem" }}>
            Changed
          </span>
        )}
      </td>
    </tr>
  );
}

/**
 * Receiving-party amendment review remediation: the full "what will actually change" view — current
 * vs proposed terms, the proposed effective schedule, and a clear "not yet effective" banner so this
 * can never be mistaken for the currently executed agreement. Reads only `amendment.terms`/
 * `frequency`/`feeAllocation` (already delivered on every amendment record — never a second, partial
 * amendment-summary payload) plus a lazily-fetched schedule preview for the itemized due-date table.
 */
function AmendmentReviewView({
  amendment,
  currentTerms,
  currentFrequency,
  currentFeeAllocation,
  currentSchedule,
  currency,
}: {
  amendment: AmendmentItem;
  currentTerms: AgreementTerms;
  currentFrequency: "weekly" | "biweekly" | "monthly";
  currentFeeAllocation: "creditor_pays" | "debtor_pays" | "split_evenly";
  currentSchedule: ScheduleItem[];
  currency: string;
}) {
  const [preview, setPreview] = useState<AmendmentPreviewData | "loading" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    apiFetch<AmendmentPreviewData>(`/api/agreements/amendments/preview?id=${amendment.id}`)
      .then((body) => {
        if (!cancelled) setPreview(body);
      })
      .catch(() => {
        if (!cancelled) setPreview("error");
      });
    return () => {
      cancelled = true;
    };
  }, [amendment.id]);

  const nextDueCurrent = currentSchedule[0]?.dueDate ?? currentTerms.firstPaymentDate;
  const nextDueProposed = amendment.terms.firstPaymentDate;

  return (
    <div className="card" style={{ marginTop: "0.75rem", border: "2px solid var(--gold-strong, #7a5610)" }}>
      <p
        role="status"
        style={{
          margin: "0 0 1rem",
          padding: "0.6rem 0.85rem",
          borderRadius: "0.6rem",
          fontWeight: 700,
          fontSize: "0.85rem",
          background: "var(--gold-soft)",
          color: "#7a5610",
        }}
      >
        PROPOSED REVISED AGREEMENT — NOT YET EFFECTIVE. The current, executed agreement (shown above) remains
        controlling until this amendment is accepted and, if required, fully signed.
      </p>

      <p style={{ margin: 0 }}>
        Proposed by <strong>{amendment.proposingPartyRole}</strong> on {formatDate(amendment.createdAt)}
      </p>
      <p style={{ margin: "0.35rem 0 0" }}>
        <strong>Reason:</strong> {amendment.reason}
      </p>
      {amendment.requestedRelief && (
        <p style={{ margin: "0.35rem 0 0" }}>
          <strong>Requested relief:</strong> {amendment.requestedRelief}
        </p>
      )}
      {amendment.proposedEffectiveDate && (
        <p style={{ margin: "0.35rem 0 0" }}>
          <strong>Proposed effective date:</strong> {formatDate(amendment.proposedEffectiveDate)}
        </p>
      )}

      <div className="table-wrap table-wrap--responsive-cards" style={{ marginTop: "1rem" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Term</th>
              <th>Current</th>
              <th>Proposed</th>
            </tr>
          </thead>
          <tbody>
            <ComparisonRow
              label="Payment amount"
              current={formatMoney(currentTerms.installmentAmountMinorUnits, currency)}
              proposed={formatMoney(amendment.terms.installmentAmountMinorUnits, currency)}
            />
            <ComparisonRow label="Frequency" current={frequencyLabel(currentFrequency)} proposed={frequencyLabel(amendment.frequency)} />
            <ComparisonRow
              label="Fee allocation"
              current={feeAllocationLabel(currentFeeAllocation)}
              proposed={feeAllocationLabel(amendment.feeAllocation)}
            />
            <ComparisonRow label="Next due date" current={formatDate(nextDueCurrent)} proposed={formatDate(nextDueProposed)} />
            <ComparisonRow
              label="Remaining balance"
              current={formatMoney(currentTerms.currentPrincipalMinorUnits, currency)}
              proposed={formatMoney(amendment.terms.currentPrincipalMinorUnits, currency)}
            />
            <ComparisonRow
              label="Final payment amount"
              current={formatMoney(currentTerms.finalPaymentMinorUnits, currency)}
              proposed={formatMoney(amendment.terms.finalPaymentMinorUnits, currency)}
            />
            <ComparisonRow
              label="Remaining schedule"
              current={`${currentTerms.numberOfInstallments} payments`}
              proposed={`${amendment.terms.numberOfInstallments} payments`}
            />
          </tbody>
        </table>
      </div>

      {(currentTerms.earlyPayoffTerms !== amendment.terms.earlyPayoffTerms ||
        currentTerms.hardshipRules !== amendment.terms.hardshipRules ||
        currentTerms.partialPaymentRules !== amendment.terms.partialPaymentRules ||
        currentTerms.settlementRules !== amendment.terms.settlementRules ||
        currentTerms.disputeProcedure !== amendment.terms.disputeProcedure ||
        currentTerms.description !== amendment.terms.description) && (
        <div className="table-wrap table-wrap--responsive-cards" style={{ marginTop: "1rem" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Contract term</th>
                <th>Current</th>
                <th>Proposed</th>
              </tr>
            </thead>
            <tbody>
              <ComparisonRow label="Description" current={currentTerms.description} proposed={amendment.terms.description} />
              <ComparisonRow label="Early payoff terms" current={currentTerms.earlyPayoffTerms} proposed={amendment.terms.earlyPayoffTerms} />
              <ComparisonRow label="Hardship rules" current={currentTerms.hardshipRules} proposed={amendment.terms.hardshipRules} />
              <ComparisonRow label="Partial payment rules" current={currentTerms.partialPaymentRules} proposed={amendment.terms.partialPaymentRules} />
              <ComparisonRow label="Settlement rules" current={currentTerms.settlementRules} proposed={amendment.terms.settlementRules} />
              <ComparisonRow label="Dispute procedure" current={currentTerms.disputeProcedure} proposed={amendment.terms.disputeProcedure} />
            </tbody>
          </table>
        </div>
      )}

      <details style={{ marginTop: "1rem" }}>
        <summary>Full proposed revised agreement text</summary>
        <div className="card" style={{ marginTop: "0.5rem" }}>
          <p style={{ margin: 0 }}>
            <strong>{amendment.terms.category}</strong> — {amendment.terms.description}
          </p>
          <p style={{ margin: "0.4rem 0 0" }}>Original amount: {formatMoney(amendment.terms.originalAmountMinorUnits, currency)}</p>
          <p style={{ margin: 0 }}>Previous payments: {formatMoney(amendment.terms.previousPaymentsMinorUnits, currency)}</p>
          <p style={{ margin: 0 }}>Current principal: {formatMoney(amendment.terms.currentPrincipalMinorUnits, currency)}</p>
          <p style={{ margin: 0 }}>
            First payment: {formatMoney(amendment.terms.firstPaymentMinorUnits, currency)} on {formatDate(amendment.terms.firstPaymentDate)}
          </p>
          <p style={{ margin: 0 }}>
            {frequencyLabel(amendment.frequency)} installments of {formatMoney(amendment.terms.installmentAmountMinorUnits, currency)} (
            {amendment.terms.numberOfInstallments} remaining, final payment {formatMoney(amendment.terms.finalPaymentMinorUnits, currency)})
          </p>
          <p style={{ margin: 0 }}>Fee allocation: {feeAllocationLabel(amendment.feeAllocation)}</p>
          <p style={{ margin: "0.4rem 0 0" }}>
            <strong>Early payoff terms:</strong> {amendment.terms.earlyPayoffTerms}
          </p>
          <p style={{ margin: "0.4rem 0 0" }}>
            <strong>Hardship rules:</strong> {amendment.terms.hardshipRules}
          </p>
          <p style={{ margin: "0.4rem 0 0" }}>
            <strong>Partial payment rules:</strong> {amendment.terms.partialPaymentRules}
          </p>
          <p style={{ margin: "0.4rem 0 0" }}>
            <strong>Settlement rules:</strong> {amendment.terms.settlementRules}
          </p>
          <p style={{ margin: "0.4rem 0 0" }}>
            <strong>Dispute procedure:</strong> {amendment.terms.disputeProcedure}
          </p>
        </div>
      </details>

      <div style={{ marginTop: "1rem" }}>
        <h4 style={{ margin: "0 0 0.5rem" }}>Proposed effective payment schedule</h4>
        {preview === "loading" && <p className="form-status">Loading proposed schedule…</p>}
        {preview === "error" && <p className="field-error" role="alert">Could not load the proposed schedule. Please try again.</p>}
        {preview !== "loading" && preview !== "error" && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Due date</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {preview.schedule.map((item) => (
                  <tr key={item.sequenceNumber}>
                    <td>{item.sequenceNumber === 0 ? "First payment" : item.sequenceNumber}</td>
                    <td>{formatDate(item.dueDate)}</td>
                    <td>{formatMoney(item.amountMinorUnits, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function AmendmentPanel({
  agreementId,
  amendments,
  myRole,
  currentTerms,
  currentFrequency,
  currentFeeAllocation,
  currentSchedule,
  currency,
  onChanged,
}: {
  agreementId: string;
  amendments: AmendmentItem[];
  myRole: "creditor" | "debtor" | null;
  currentTerms: AgreementTerms;
  currentFrequency: "weekly" | "biweekly" | "monthly";
  currentFeeAllocation: "creditor_pays" | "debtor_pays" | "split_evenly";
  currentSchedule: ScheduleItem[];
  currency: string;
  onChanged: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [changeType, setChangeType] = useState<"new_date" | "temporary_pause" | "reduced_installment" | "revised_schedule" | "general">("general");
  const [reason, setReason] = useState("");
  const [proposedTerms, setProposedTerms] = useState<AgreementTermsFormValues>(BLANK_AGREEMENT_TERMS);
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function propose(event: React.FormEvent) {
    event.preventDefault();
    setStatus("working");
    try {
      await apiFetch("/api/agreements/amendments/propose", {
        method: "POST",
        body: JSON.stringify({ agreementId, changeType, reason, proposedTerms }),
      });
      setShowForm(false);
      setReason("");
      onChanged();
    } catch {
      setStatus("error");
    }
  }

  async function decide(amendmentId: string, decision: "accept" | "reject") {
    setActionError(null);
    try {
      await apiFetch("/api/agreements/amendments/decide", { method: "POST", body: JSON.stringify({ amendmentId, decision }) });
      onChanged();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Could not record this decision.");
    }
  }

  async function sign(amendmentId: string) {
    setActionError(null);
    try {
      await apiFetch("/api/agreements/amendments/sign", { method: "POST", body: JSON.stringify({ amendmentId }) });
      onChanged();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "Could not sign this amendment.");
    }
  }

  return (
    <div className="card">
      <div className="card__header">
        <h3>Amendments</h3>
        {myRole && !showForm && (
          <button type="button" className="button button--ghost" onClick={() => setShowForm(true)}>
            Propose amendment
          </button>
        )}
      </div>

      {actionError && (
        <p className="field-error" role="alert">
          {actionError}
        </p>
      )}

      {amendments.length === 0 ? (
        <p className="form-status">No amendments proposed.</p>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {amendments.map((amendment) => {
            const iSigned = myRole === "creditor" ? !!amendment.creditorSignedAt : myRole === "debtor" ? !!amendment.debtorSignedAt : false;
            const termsLoaded = !!amendment.terms;
            return (
              <div key={amendment.id} className="card" style={{ background: "var(--forest-50)" }}>
                <div className="card__header">
                  <strong>{amendmentChangeTypeLabel(amendment.changeType as Parameters<typeof amendmentChangeTypeLabel>[0]).label}</strong>
                  <Chip {...amendmentStatusLabel(amendment.status as Parameters<typeof amendmentStatusLabel>[0])} />
                </div>
                <p style={{ margin: 0 }}>{amendment.reason}</p>
                <p style={{ margin: "0.35rem 0 0", color: "var(--ink-soft)", fontSize: "0.85rem" }}>
                  Proposed by {amendment.proposingPartyRole} on {formatDate(amendment.createdAt)}. Current terms shown above are unchanged
                  until this amendment is fully signed.
                </p>

                <div className="hero__actions" style={{ marginTop: "0.5rem" }}>
                  <button
                    type="button"
                    className="button button--ghost"
                    aria-expanded={expandedId === amendment.id}
                    onClick={() => setExpandedId((current) => (current === amendment.id ? null : amendment.id))}
                  >
                    {expandedId === amendment.id ? "Hide revised agreement" : "View revised agreement"}
                  </button>
                  {amendment.status === "proposed" && myRole && myRole !== amendment.proposingPartyRole && (
                    <>
                      <button
                        type="button"
                        className="button button--primary"
                        disabled={!termsLoaded}
                        onClick={() => void decide(amendment.id, "accept")}
                      >
                        Accept
                      </button>
                      <button type="button" className="button button--ghost" onClick={() => void decide(amendment.id, "reject")}>
                        Reject
                      </button>
                    </>
                  )}
                  {amendment.status === "awaiting_signatures" && myRole && !iSigned && (
                    <button type="button" className="button button--primary" onClick={() => void sign(amendment.id)}>
                      Sign amendment
                    </button>
                  )}
                  {amendment.status === "awaiting_signatures" && myRole && iSigned && (
                    <span className="form-status" style={{ alignSelf: "center" }}>
                      You&apos;ve signed. Waiting for the other party to sign.
                    </span>
                  )}
                </div>

                {expandedId === amendment.id && (
                  <AmendmentReviewView
                    amendment={amendment}
                    currentTerms={currentTerms}
                    currentFrequency={currentFrequency}
                    currentFeeAllocation={currentFeeAllocation}
                    currentSchedule={currentSchedule}
                    currency={currency}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <form onSubmit={(event) => void propose(event)} className="card" style={{ marginTop: "1rem" }}>
          <div className="field">
            <label htmlFor="amendment-change-type">Type of change</label>
            <select id="amendment-change-type" value={changeType} onChange={(event) => setChangeType(event.target.value as typeof changeType)}>
              <option value="new_date">New date</option>
              <option value="temporary_pause">Temporary pause</option>
              <option value="reduced_installment">Reduced installment</option>
              <option value="revised_schedule">Revised schedule</option>
              <option value="general">General</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="amendment-reason">Reason</label>
            <textarea id="amendment-reason" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={2000} />
          </div>
          <details style={{ marginTop: "0.5rem" }}>
            <summary>Proposed terms</summary>
            <AgreementTermsFields values={proposedTerms} onChange={(patch) => setProposedTerms((prev) => ({ ...prev, ...patch }))} />
          </details>
          {status === "error" && (
            <p className="field-error" role="alert">
              Could not submit this amendment. Please check the form and try again.
            </p>
          )}
          <div className="hero__actions" style={{ marginTop: "0.75rem" }}>
            <button type="submit" className="button button--primary" disabled={status === "working"}>
              Propose
            </button>
            <button type="button" className="button button--ghost" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function PartialPaymentPanel({
  agreementId,
  requests,
  myRole,
  onChanged,
}: {
  agreementId: string;
  requests: PartialPaymentItem[];
  myRole: "creditor" | "debtor" | null;
  onChanged: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");

  async function propose(event: React.FormEvent) {
    event.preventDefault();
    setStatus("working");
    try {
      await apiFetch("/api/agreements/partial-payments/propose", {
        method: "POST",
        body: JSON.stringify({ agreementId, proposedAmountMinorUnits: Math.round(Number(amount) * 100), proposedDate: date }),
      });
      setShowForm(false);
      onChanged();
    } catch {
      setStatus("error");
    }
  }

  async function decide(partialPaymentRequestId: string, decision: "accept" | "reject") {
    await apiFetch("/api/agreements/partial-payments/decide", { method: "POST", body: JSON.stringify({ partialPaymentRequestId, decision }) });
    onChanged();
  }

  return (
    <div className="card">
      <div className="card__header">
        <h3>Partial payments</h3>
        {myRole === "debtor" && !showForm && (
          <button type="button" className="button button--ghost" onClick={() => setShowForm(true)}>
            Propose partial payment
          </button>
        )}
      </div>
      {requests.length === 0 ? (
        <p className="form-status">No partial payment requests.</p>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {requests.map((r) => (
            <div key={r.id} className="card" style={{ background: "var(--forest-50)" }}>
              <div className="card__header">
                <strong>{formatMoney(r.proposedAmountMinorUnits)} on {formatDate(r.proposedDate)}</strong>
                <Chip {...partialPaymentRequestStatusLabel(r.status as Parameters<typeof partialPaymentRequestStatusLabel>[0])} />
              </div>
              {r.explanation && <p style={{ margin: 0 }}>{r.explanation}</p>}
              <p style={{ margin: "0.35rem 0 0", color: "var(--ink-soft)", fontSize: "0.85rem" }}>
                Remainder is not automatically forgiven unless the agreement&apos;s own partial payment rules say otherwise.
              </p>
              {r.status === "proposed" && myRole === "creditor" && (
                <div className="hero__actions" style={{ marginTop: "0.5rem" }}>
                  <button type="button" className="button button--primary" onClick={() => void decide(r.id, "accept")}>
                    Accept
                  </button>
                  <button type="button" className="button button--ghost" onClick={() => void decide(r.id, "reject")}>
                    Reject
                  </button>
                </div>
              )}
              {r.status === "awaiting_payment" && (
                <p className="confirm-banner" style={{ marginTop: "0.5rem" }}>
                  Payment required — go to <a href="/payments">My Cash</a> to pay this amount.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {showForm && (
        <form onSubmit={(event) => void propose(event)} className="card" style={{ marginTop: "1rem" }}>
          <div className="early-access-form__row">
            <div className="field">
              <label htmlFor="partial-amount">Amount</label>
              <input id="partial-amount" type="number" step="0.01" min="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="partial-date">Date</label>
              <input id="partial-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
            </div>
          </div>
          {status === "error" && (
            <p className="field-error" role="alert">
              Could not submit this request.
            </p>
          )}
          <div className="hero__actions">
            <button type="submit" className="button button--primary" disabled={status === "working"}>
              Propose
            </button>
            <button type="button" className="button button--ghost" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function SettlementPanel({
  proposals,
  myRole,
  proposeAction,
  decideAction,
  onChanged,
}: {
  agreementId: string;
  proposals: SettlementItem[];
  myRole: "creditor" | "debtor" | null;
  proposeAction: ReturnType<typeof useStepUpGuardedAction<[Record<string, unknown>], unknown>>;
  decideAction: ReturnType<typeof useStepUpGuardedAction<[{ settlementProposalId: string; decision: "accept" | "reject" | "counter" }], unknown>>;
  onChanged: () => void;
}) {
  const [activeChallenge, setActiveChallenge] = useState<"propose" | "decide" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(settlementProposalId: string, decision: "accept" | "reject") {
    setError(null);
    try {
      await decideAction.run({ settlementProposalId, decision });
      onChanged();
    } catch (e) {
      if (decideAction.isChallengeOpen) setActiveChallenge("decide");
      else setError(e instanceof ApiError ? e.message : "Could not record this decision.");
    }
  }

  return (
    <div className="card">
      <div className="card__header">
        <h3>Settlements</h3>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {proposals.length === 0 ? (
        <p className="form-status">No settlement proposals. A settlement is a material action requiring a fresh verification challenge.</p>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {proposals.map((s) => {
            const chip = settlementProposalStatusLabel(s.status as Parameters<typeof settlementProposalStatusLabel>[0]);
            return (
              <div key={s.id} className="card" style={{ background: "var(--forest-50)" }}>
                <div className="card__header">
                  <strong>Settle for {formatMoney(s.settlementAmountMinorUnits)}</strong>
                  <Chip {...chip} />
                </div>
                <p style={{ margin: 0 }}>Outstanding balance: {formatMoney(s.preSettlementBalanceMinorUnits)}</p>
                <p style={{ margin: 0 }}>Deadline: {formatDate(s.deadline)}</p>
                {/* Hard rule: forgiven amount is only ever shown once status is "completed" — never at "accepted/awaiting_payment", so acceptance can never visually read as forgiveness having happened. */}
                {s.status === "completed" ? (
                  <p style={{ margin: 0 }}>Forgiven: {formatMoney(s.forgivenAmountMinorUnits)} (as of {s.completedAt ? formatDate(s.completedAt) : ""})</p>
                ) : (
                  <p style={{ margin: 0, color: "var(--ink-soft)" }}>Forgiveness applies only once payment is completed.</p>
                )}
                {s.status === "proposed" && myRole && myRole !== s.proposingPartyRole && (
                  <div className="hero__actions" style={{ marginTop: "0.5rem" }}>
                    <button type="button" className="button button--primary" onClick={() => void decide(s.id, "accept")}>
                      Accept
                    </button>
                    <button type="button" className="button button--ghost" onClick={() => void decide(s.id, "reject")}>
                      Reject
                    </button>
                  </div>
                )}
                {s.status === "awaiting_payment" && (
                  <p className="confirm-banner" style={{ marginTop: "0.5rem" }}>
                    Payment required — go to <a href="/payments">My Cash</a> to complete this settlement.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {(proposeAction.isChallengeOpen || (activeChallenge === "decide" && decideAction.isChallengeOpen)) && (
        <StepUpChallenge
          action={activeChallenge === "decide" ? "settlement_decide" : "settlement_propose"}
          actionDescription="continue with this settlement"
          onVerified={() => {
            if (activeChallenge === "decide") decideAction.resolveChallenge();
            else proposeAction.resolveChallenge();
            setActiveChallenge(null);
            onChanged();
          }}
          onCancel={() => {
            if (activeChallenge === "decide") decideAction.cancelChallenge();
            else proposeAction.cancelChallenge();
            setActiveChallenge(null);
          }}
        />
      )}
    </div>
  );
}

function DisputePanel({ agreementId, disputes, onChanged }: { agreementId: string; disputes: DisputeItem[]; onChanged: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [category, setCategory] = useState<"debt_does_not_exist" | "incorrect_amount" | "evidence_challenged" | "administration_challenged" | "other">("other");
  const [explanation, setExplanation] = useState("");
  const [responseText, setResponseText] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");

  async function open(event: React.FormEvent) {
    event.preventDefault();
    setStatus("working");
    try {
      await apiFetch("/api/agreements/disputes/open", { method: "POST", body: JSON.stringify({ agreementId, category, explanation }) });
      setShowForm(false);
      setExplanation("");
      onChanged();
    } catch {
      setStatus("error");
    }
  }

  async function respond(disputeId: string) {
    await apiFetch("/api/agreements/disputes/respond", { method: "POST", body: JSON.stringify({ disputeId, response: responseText[disputeId] ?? "" }) });
    onChanged();
  }

  return (
    <div className="card">
      <div className="card__header">
        <h3>Disputes</h3>
        {!showForm && (
          <button type="button" className="button button--ghost" onClick={() => setShowForm(true)}>
            Open dispute
          </button>
        )}
      </div>
      <p style={{ margin: "0 0 0.75rem", color: "var(--ink-soft)", fontSize: "0.85rem" }}>
        PAY2PAY records both parties&apos; statements and evidence here so there is a shared, dated
        record. It does not investigate, judge, or decide who is right, and it does not reverse a
        payment on its own — it is a record-keeping tool for a disagreement you and the other party
        need to work out directly. For account, payment, or platform issues, see{" "}
        <a href="/support">Support</a>.
      </p>

      {disputes.length === 0 ? (
        <p className="form-status">No disputes on this agreement.</p>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {disputes.map((d) => (
            <div key={d.id} className="card" style={{ background: "var(--forest-50)" }}>
              <div className="card__header">
                <strong>{d.category.replaceAll("_", " ")}</strong>
                <Chip {...agreementDisputeStatusLabel(d.status as Parameters<typeof agreementDisputeStatusLabel>[0])} />
              </div>
              <p style={{ margin: 0 }}>{d.explanation}</p>
              {d.response && <p style={{ margin: "0.35rem 0 0", color: "var(--ink-soft)" }}>Response: {d.response}</p>}
              {d.resolutionNotes && <p style={{ margin: "0.35rem 0 0" }}>Resolution: {d.resolutionNotes}</p>}
              {d.restrictedReason && !d.restrictionLiftedAt && (
                <p className="form-status form-status--error" style={{ marginTop: "0.5rem" }}>
                  This agreement is currently restricted pending review. Contact support for details.
                </p>
              )}
              {d.status === "opened" && !d.response && (
                <div style={{ marginTop: "0.5rem" }}>
                  <div className="field">
                    <label htmlFor={`respond-${d.id}`}>Your response</label>
                    <textarea
                      id={`respond-${d.id}`}
                      value={responseText[d.id] ?? ""}
                      onChange={(event) => setResponseText((prev) => ({ ...prev, [d.id]: event.target.value }))}
                      maxLength={4000}
                    />
                  </div>
                  <button type="button" className="button button--ghost" onClick={() => void respond(d.id)}>
                    Send response
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <form onSubmit={(event) => void open(event)} className="card" style={{ marginTop: "1rem" }}>
          <div className="field">
            <label htmlFor="dispute-category">Category</label>
            <select id="dispute-category" value={category} onChange={(event) => setCategory(event.target.value as typeof category)}>
              <option value="debt_does_not_exist">The debt does not exist</option>
              <option value="incorrect_amount">Incorrect amount</option>
              <option value="evidence_challenged">Evidence challenged</option>
              <option value="administration_challenged">Agreement administration challenged</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="dispute-explanation">Explanation</label>
            <textarea id="dispute-explanation" value={explanation} onChange={(event) => setExplanation(event.target.value)} required maxLength={4000} />
          </div>
          {status === "error" && (
            <p className="field-error" role="alert">
              Could not open this dispute.
            </p>
          )}
          <div className="hero__actions">
            <button type="submit" className="button button--primary" disabled={status === "working"}>
              Open dispute
            </button>
            <button type="button" className="button button--ghost" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * Mutual cancellation (mandatory command): "Request Cancellation" on an already-active agreement —
 * distinct from the pre-signature "Cancel Agreement" action elsewhere on this page (see
 * AgreementCancellationService's own doc comment for why post-execution cancellation must be a real
 * two-party consent, not a unilateral withdraw). The agreement stays visibly active while a request
 * is pending — "pending cancellation" is this panel's own status, never agreement.status itself —
 * and the counterparty reviews it right here, on the same page as the full agreement they're
 * deciding about, before accepting or declining.
 */
function AgreementCancellationPanel({
  agreementId,
  myRole,
  requests,
  onChanged,
}: {
  agreementId: string;
  myRole: "creditor" | "debtor";
  requests: CancellationRequestItem[];
  onChanged: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [reason, setReason] = useState("");
  const [declineReason, setDeclineReason] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const pending = requests.find((r) => r.status === "pending");

  async function handleRequest(event: React.FormEvent) {
    event.preventDefault();
    setStatus("working");
    setError(null);
    try {
      await apiFetch("/api/agreements/cancellation-requests", {
        method: "POST",
        body: JSON.stringify({ agreementId, reason }),
      });
      setShowForm(false);
      setReason("");
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not submit this cancellation request.");
      setStatus("error");
    }
  }

  async function handleDecide(decision: "accept" | "reject") {
    if (!pending) return;
    setStatus("working");
    setError(null);
    try {
      await apiFetch("/api/agreements/cancellation-requests/decide", {
        method: "POST",
        body: JSON.stringify({ cancellationRequestId: pending.id, decision, rejectedReason: decision === "reject" ? declineReason || undefined : undefined }),
      });
      setDeclineReason("");
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not record this decision.");
      setStatus("error");
    }
  }

  return (
    <div className="card">
      <div className="card__header">
        <h3>Mutual cancellation</h3>
        {!pending && !showForm && (
          <button type="button" className="button button--ghost" onClick={() => setShowForm(true)}>
            Request Cancellation
          </button>
        )}
      </div>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      {pending && pending.requestedByPartyRole === myRole && (
        <p className="form-status" role="status">
          Cancellation requested — awaiting the other party&apos;s response. Reason given: &quot;{pending.reason}&quot;
        </p>
      )}

      {pending && pending.requestedByPartyRole !== myRole && (
        <div className="card" style={{ background: "var(--forest-50)" }}>
          <p style={{ margin: 0 }}>
            <strong>The other party has requested to cancel this agreement.</strong>
          </p>
          <p style={{ margin: "0.35rem 0 0" }}>Reason: &quot;{pending.reason}&quot;</p>
          <p style={{ margin: "0.35rem 0 0", color: "var(--ink-soft)", fontSize: "0.85rem" }}>
            Accepting cancels this agreement by mutual agreement. Declining leaves it active, unchanged.
          </p>
          <div className="field" style={{ marginTop: "0.5rem" }}>
            <label htmlFor="cancellation-decline-reason">Reason if declining (optional)</label>
            <input id="cancellation-decline-reason" value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} />
          </div>
          <div className="hero__actions" style={{ marginTop: "0.5rem" }}>
            <button type="button" className="button button--primary" disabled={status === "working"} onClick={() => void handleDecide("accept")}>
              Accept cancellation
            </button>
            <button type="button" className="button button--ghost" disabled={status === "working"} onClick={() => void handleDecide("reject")}>
              Decline
            </button>
          </div>
        </div>
      )}

      {!pending && !showForm && <p className="form-status">No cancellation request is pending.</p>}

      {showForm && (
        <form onSubmit={(event) => void handleRequest(event)} className="card" style={{ marginTop: "1rem" }}>
          <div className="field">
            <label htmlFor="cancellation-reason">Reason for requesting cancellation</label>
            <textarea id="cancellation-reason" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={2000} />
          </div>
          <div className="hero__actions">
            <button type="submit" className="button button--primary" disabled={status === "working"}>
              Submit request
            </button>
            <button type="button" className="button button--ghost" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
