"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  AgreementTermsFields,
  BLANK_AGREEMENT_TERMS,
  type AgreementTermsFormValues,
} from "./AgreementTermsFields";
import { StepUpChallenge } from "./StepUpChallenge";
import type { SelectableProfile } from "./ProfileSwitcher";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
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
  terms: AgreementTerms;
  frequency: string;
  creditorSignedAt: string | null;
  debtorSignedAt: string | null;
  createdAt: string;
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

  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [witnesses, setWitnesses] = useState<WitnessItem[]>([]);
  const [amendments, setAmendments] = useState<AmendmentItem[]>([]);
  const [partialPayments, setPartialPayments] = useState<PartialPaymentItem[]>([]);
  const [settlements, setSettlements] = useState<SettlementItem[]>([]);
  const [disputes, setDisputes] = useState<DisputeItem[]>([]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

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
      const [evidenceRes, witnessRes, amendmentRes, partialRes, settlementRes, disputeRes] = await Promise.all([
        apiFetch<{ evidence: EvidenceItem[] }>(`/api/agreements/evidence?agreementId=${agreementId}`).catch(() => ({ evidence: [] })),
        apiFetch<{ witnesses: WitnessItem[] }>(`/api/agreements/witnesses?agreementId=${agreementId}`).catch(() => ({ witnesses: [] })),
        apiFetch<{ amendments: AmendmentItem[] }>(`/api/agreements/amendments?agreementId=${agreementId}`).catch(() => ({ amendments: [] })),
        apiFetch<{ requests: PartialPaymentItem[] }>(`/api/agreements/partial-payments?agreementId=${agreementId}`).catch(() => ({ requests: [] })),
        apiFetch<{ proposals: SettlementItem[] }>(`/api/agreements/settlements?agreementId=${agreementId}`).catch(() => ({ proposals: [] })),
        apiFetch<{ disputes: DisputeItem[] }>(`/api/agreements/disputes?agreementId=${agreementId}`).catch(() => ({ disputes: [] })),
      ]);
      setEvidence(evidenceRes.evidence);
      setWitnesses(witnessRes.witnesses);
      setAmendments(amendmentRes.amendments);
      setPartialPayments(partialRes.requests);
      setSettlements(settlementRes.proposals);
      setDisputes(disputeRes.disputes);
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
        </div>
      )}

      {data.status === "awaiting_debtor_acknowledgment" && (
        <div className="hero__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={actionStatus === "working"}
            onClick={() => void runAction(() => apiFetch("/api/agreements/acknowledge", { method: "POST", body: JSON.stringify({ agreementId: data.id }) }))}
          >
            I acknowledge this obligation is owed
          </button>
        </div>
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
          myRole={myRole}
          creditorSignedAt={data.version.creditorSignedAt}
          debtorSignedAt={data.version.debtorSignedAt}
          signAction={signAction}
        />
      )}

      <EvidenceWitnessPanel
        agreementId={data.id}
        evidence={evidence}
        witnesses={witnesses}
        onChanged={() => void load()}
      />

      <AmendmentPanel agreementId={data.id} amendments={amendments} myRole={myRole} onChanged={() => void load()} />

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
  myRole,
  creditorSignedAt,
  debtorSignedAt,
  signAction,
}: {
  myRole: "creditor" | "debtor";
  creditorSignedAt: string | null;
  debtorSignedAt: string | null;
  signAction: ReturnType<typeof useStepUpGuardedAction<["totp" | "sms"], unknown>>;
}) {
  const alreadySigned = myRole === "creditor" ? !!creditorSignedAt : !!debtorSignedAt;
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="card">
      <div className="card__header">
        <h3>Signature</h3>
      </div>
      <p style={{ margin: 0 }}>Creditor signed: {creditorSignedAt ? formatDateTime(creditorSignedAt) : "not yet"}</p>
      <p style={{ margin: "0.25rem 0 0" }}>Debtor signed: {debtorSignedAt ? formatDateTime(debtorSignedAt) : "not yet"}</p>
      <p className="form-status" style={{ marginTop: "0.75rem" }}>
        By signing, you consent to this agreement&apos;s terms as shown above. A fresh verification challenge is required.
      </p>
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
            signAction
              .run("totp")
              .then(() => window.location.reload())
              .catch((e: unknown) => {
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

function AmendmentPanel({
  agreementId,
  amendments,
  myRole,
  onChanged,
}: {
  agreementId: string;
  amendments: AmendmentItem[];
  myRole: "creditor" | "debtor" | null;
  onChanged: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [changeType, setChangeType] = useState<"new_date" | "temporary_pause" | "reduced_installment" | "revised_schedule" | "general">("general");
  const [reason, setReason] = useState("");
  const [proposedTerms, setProposedTerms] = useState<AgreementTermsFormValues>(BLANK_AGREEMENT_TERMS);
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");

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
    await apiFetch("/api/agreements/amendments/decide", { method: "POST", body: JSON.stringify({ amendmentId, decision }) });
    onChanged();
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

      {amendments.length === 0 ? (
        <p className="form-status">No amendments proposed.</p>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {amendments.map((amendment) => (
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
              {amendment.status === "proposed" && myRole && myRole !== amendment.proposingPartyRole && (
                <div className="hero__actions" style={{ marginTop: "0.5rem" }}>
                  <button type="button" className="button button--primary" onClick={() => void decide(amendment.id, "accept")}>
                    Accept
                  </button>
                  <button type="button" className="button button--ghost" onClick={() => void decide(amendment.id, "reject")}>
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
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
                  Payment required — go to <a href="/payments">Payments</a> to pay this amount.
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
                    Payment required — go to <a href="/payments">Payments</a> to complete this settlement.
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
