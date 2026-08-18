"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiFetch } from "@/lib/ui/apiFetch";
import { formatMoney } from "@/lib/ui/money";
import { formatDate, formatDateTime } from "@/lib/ui/date";
import { paymentAttemptStatusLabel, paymentDisputeStatusLabel } from "@/lib/ui/statusLabels";

interface PaymentDetailData {
  id: string;
  status: string;
  amountMinorUnits: number;
  currency: string;
  payer: { profileKind: "personal" | "business"; profileId: string };
  recipient: { profileKind: "personal" | "business"; profileId: string };
  agreementId: string | null;
  providerName: string;
  paymentMethod: "ach" | "debit_card" | "manual_off_platform" | null;
  recipientConfirmedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RetryStatus {
  id: string;
  status: "scheduled" | "fired" | "canceled";
  scheduledFor: string;
  resultingPaymentAttemptId: string | null;
}

interface PaymentDispute {
  id: string;
  status: "claimed" | "upheld" | "denied";
  category: string;
  explanation: string;
  claimedAt: string;
  resolutionNotes: string | null;
  resolvedAt: string | null;
}

type LoadStatus = "loading" | "ready" | "not-found" | "unauthorized" | "error";

/** Sprint 13: never show a raw processor error string — map the safe failure category to plain language. */
const FAILURE_REASON_LABEL: Record<string, string> = {
  insufficient_funds: "The payment method had insufficient funds.",
  account_closed: "The bank account or card is no longer valid.",
  authorization_expired: "The payment authorization has expired.",
  provider_error: "The payment provider could not process this payment.",
  unknown_processor_error: "The payment could not be completed.",
};

function safeFailureMessage(reason: string | null): string {
  if (!reason) return "This payment failed.";
  return FAILURE_REASON_LABEL[reason] ?? "This payment failed.";
}

export function PaymentDetail() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [payment, setPayment] = useState<PaymentDetailData | null>(null);
  const [retry, setRetry] = useState<RetryStatus | null>(null);
  const [disputes, setDisputes] = useState<PaymentDispute[]>([]);
  const [manualPayStatus, setManualPayStatus] = useState<"idle" | "confirming" | "submitting" | "done" | "error">("idle");
  const [confirmStatus, setConfirmStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");

  const load = useCallback(async () => {
    if (!id) {
      setStatus("error");
      return;
    }
    try {
      const detail = await apiFetch<PaymentDetailData>(`/api/payments/detail?id=${id}`);
      setPayment(detail);
      const [retryBody, disputesBody] = await Promise.all([
        apiFetch<{ retry: RetryStatus | null }>(`/api/payments/retry-status?paymentId=${id}`),
        apiFetch<{ disputes: PaymentDispute[] }>(`/api/payments/disputes/by-payment?paymentAttemptId=${id}`),
      ]);
      setRetry(retryBody.retry);
      setDisputes(disputesBody.disputes);
      setStatus("ready");
    } catch (error: unknown) {
      if (error instanceof ApiError && error.httpStatus === 401) setStatus("unauthorized");
      else if (error instanceof ApiError && error.httpStatus === 400) setStatus("not-found");
      else setStatus("error");
    }
  }, [id]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function handleManualPay() {
    if (!payment || !payment.agreementId) return;
    setManualPayStatus("submitting");
    try {
      const endpoint = payment.paymentMethod === "debit_card" ? "/api/debit-card/payments/manual" : "/api/ach/payments/manual";
      await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: `manual-${payment.id}-${crypto.randomUUID()}`,
          agreementId: payment.agreementId,
          payer: payment.payer,
          recipient: payment.recipient,
          amountMinorUnits: payment.amountMinorUnits,
          currency: payment.currency,
        }),
      });
      setManualPayStatus("done");
      await load();
    } catch {
      setManualPayStatus("error");
    }
  }

  async function handleConfirmManualPayment() {
    if (!payment) return;
    setConfirmStatus("submitting");
    try {
      await apiFetch("/api/payments/manual/confirm", { method: "POST", body: JSON.stringify({ id: payment.id }) });
      setConfirmStatus("done");
      await load();
    } catch {
      setConfirmStatus("error");
    }
  }

  if (status === "loading") {
    return (
      <div className="card">
        <div className="skeleton skeleton--line" style={{ width: "50%" }} />
        <div className="skeleton skeleton--line" style={{ width: "70%" }} />
      </div>
    );
  }
  if (status === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert">
        You need to <a href="/login">sign in</a> to view this payment.
      </p>
    );
  }
  if (status === "not-found" || status === "error" || !payment) {
    return (
      <p className="form-status form-status--error" role="alert">
        This payment couldn&apos;t be found, or something went wrong loading it.
      </p>
    );
  }

  const { label, tone } = paymentAttemptStatusLabel(payment.status as never);
  const isFailed = payment.status === "failed";

  return (
    <div style={{ display: "grid", gap: "1.25rem" }}>
      <div className="card">
        <div className="card__header">
          <h2>Payment</h2>
          <span className={`chip chip--${tone}`}>{label}</span>
        </div>
        <p style={{ fontSize: "1.5rem", fontWeight: 700, margin: "0 0 1rem" }}>
          {formatMoney(payment.amountMinorUnits, payment.currency)}
        </p>
        <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem 1.5rem", margin: 0 }}>
          <div>
            <dt style={{ color: "var(--ink-soft)", fontSize: "0.8rem" }}>Created</dt>
            <dd style={{ margin: 0 }}>{formatDateTime(payment.createdAt)}</dd>
          </div>
          <div>
            <dt style={{ color: "var(--ink-soft)", fontSize: "0.8rem" }}>Last updated</dt>
            <dd style={{ margin: 0 }}>{formatDateTime(payment.updatedAt)}</dd>
          </div>
          {payment.agreementId && (
            <div>
              <dt style={{ color: "var(--ink-soft)", fontSize: "0.8rem" }}>Agreement</dt>
              <dd style={{ margin: 0 }}>
                <Link href={`/agreements/detail?id=${payment.agreementId}`}>View agreement</Link>
              </dd>
            </div>
          )}
        </dl>
      </div>

      {payment.paymentMethod === "manual_off_platform" && (
        <div className="card">
          <div className="card__header">
            <h3>Manually recorded payment</h3>
          </div>
          <p style={{ color: "var(--ink-soft)" }}>
            This payment was recorded as collected outside PAY2PAY (for example, cash or a check) rather than processed through
            a payment provider.
          </p>
          {payment.recipientConfirmedAt ? (
            <p className="chip chip--success" style={{ marginTop: "0.5rem" }}>
              Confirmed by the recipient on {formatDate(payment.recipientConfirmedAt)}
            </p>
          ) : (
            <div style={{ marginTop: "0.75rem" }}>
              <p style={{ margin: "0 0 0.5rem", color: "var(--ink-soft)", fontSize: "0.85rem" }}>
                Not yet confirmed by the recipient. Confirmation is optional and only strengthens the record — this payment
                already counts toward the balance.
              </p>
              {confirmStatus !== "done" && (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void handleConfirmManualPayment()}
                  disabled={confirmStatus === "submitting"}
                >
                  {confirmStatus === "submitting" ? "Confirming…" : "Confirm you received this payment"}
                </button>
              )}
              {confirmStatus === "error" && (
                <p className="field-error" role="alert">
                  This could not be confirmed. Only the payment&apos;s recipient may confirm it.
                </p>
              )}
              {confirmStatus === "done" && (
                <p className="form-status form-status--success" role="status">
                  Confirmed.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {isFailed && (
        <div className="card">
          <div className="card__header">
            <h3>Payment failed</h3>
          </div>
          <p>{safeFailureMessage(payment.failureReason)}</p>
          {retry && retry.status === "scheduled" && (
            <p className="chip chip--info" style={{ marginTop: "0.5rem" }}>
              A retry is scheduled for {formatDate(retry.scheduledFor)}
            </p>
          )}
          {retry && retry.status === "fired" && (
            <p className="chip chip--neutral" style={{ marginTop: "0.5rem" }}>
              The scheduled retry has already run.
            </p>
          )}
          {!retry && <p style={{ color: "var(--ink-soft)" }}>No automatic retry is scheduled for this payment.</p>}

          {payment.agreementId && manualPayStatus !== "done" && (
            <div style={{ marginTop: "1rem" }}>
              {manualPayStatus === "confirming" ? (
                <div className="confirm-banner">
                  <div>
                    <p style={{ margin: "0 0 0.5rem" }}>
                      Paying manually now will cancel the automatically scheduled retry, if one exists. Continue?
                    </p>
                    <div style={{ display: "flex", gap: "0.6rem" }}>
                      <button type="button" className="button button--primary" onClick={() => void handleManualPay()}>
                        Yes, pay now
                      </button>
                      <button type="button" className="button button--ghost" onClick={() => setManualPayStatus("idle")}>
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <button type="button" className="button button--primary" onClick={() => setManualPayStatus("confirming")} disabled={(manualPayStatus as string) === "submitting"}>
                  {(manualPayStatus as string) === "submitting" ? "Submitting…" : "Pay manually"}
                </button>
              )}
              {manualPayStatus === "error" && (
                <p className="field-error" role="alert">
                  The manual payment could not be submitted. Please try again.
                </p>
              )}
            </div>
          )}
          {manualPayStatus === "done" && (
            <p className="form-status form-status--success" role="status">
              A new payment has been submitted.
            </p>
          )}
        </div>
      )}

      {disputes.length > 0 && (
        <div className="card">
          <div className="card__header">
            <h3>Dispute</h3>
          </div>
          {disputes.map((dispute) => {
            const disputeLabel = paymentDisputeStatusLabel(dispute.status);
            return (
              <div key={dispute.id} style={{ marginBottom: "0.75rem" }}>
                <span className={`chip chip--${disputeLabel.tone}`}>{disputeLabel.label}</span>
                <p style={{ margin: "0.5rem 0 0" }}>{dispute.explanation}</p>
                <p style={{ margin: "0.25rem 0 0", color: "var(--ink-soft)", fontSize: "0.85rem" }}>
                  Filed {formatDate(dispute.claimedAt)}
                  {dispute.resolvedAt ? ` · Resolved ${formatDate(dispute.resolvedAt)}` : ""}
                </p>
                <p style={{ margin: "0.25rem 0 0", color: "var(--ink-soft)", fontSize: "0.82rem" }}>
                  This dispute is reviewed and decided by the payment processor, not by PAY2PAY.
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
