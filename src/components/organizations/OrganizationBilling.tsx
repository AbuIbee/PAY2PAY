"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
import { formatMoney } from "@/lib/ui/money";

interface BillingPlan {
  code: string;
  name: string;
  monthlyFeeMinorUnits: number;
  isNegotiated: boolean;
}
interface BillingBand {
  min: number;
  max: number | null;
}
interface BillingUsage {
  count: number;
  periodStart: string;
  periodEnd: string;
}
interface BillingInvoice {
  id: string;
  periodStart: string;
  periodEnd: string;
  amountDueMinorUnits: number;
  amountPaidMinorUnits: number;
  status: "open" | "paid" | "past_due" | "void";
  dueAt: string;
  paidAt: string | null;
}
interface BillingPaymentMethod {
  paymentType: "card" | "bank_account" | "other";
  displayLast4: string | null;
  displayName: string | null;
}
interface BillingSummary {
  organizationId: string;
  providerConfigured: boolean;
  subscriptionStatus: "ACTIVE" | "PAST_DUE" | "CANCEL_AT_PERIOD_END" | "CANCELED" | "SUSPENDED" | "NOT_SUBSCRIBED";
  plan: BillingPlan | null;
  band: BillingBand | null;
  usage: BillingUsage | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  paymentMethod: BillingPaymentMethod | null;
  invoices: BillingInvoice[];
  availableUpgrades: Array<{ code: string; name: string; monthlyFeeMinorUnits: number | null }>;
}

const STATUS_LABEL: Record<BillingSummary["subscriptionStatus"], string> = {
  ACTIVE: "Active",
  PAST_DUE: "Past due",
  CANCEL_AT_PERIOD_END: "Canceling at period end",
  CANCELED: "Canceled",
  SUSPENDED: "Suspended",
  NOT_SUBSCRIBED: "Not subscribed",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 10/11/13/14/16/17: the Business
 * organization's Billing & Subscription page — every field comes straight from
 * `/api/organizations/billing`'s own server-derived summary; this component holds no authorization,
 * billing, or activation decision of its own, and never renders "payment method saved"/"subscription
 * activated" text unless the server's own response says so.
 */
export function OrganizationBilling({ organizationId }: { organizationId: string }) {
  const [status, setStatus] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const body = await apiFetch<BillingSummary>(`/api/organizations/billing?organizationId=${organizationId}`);
    setSummary(body);
  }, [organizationId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
        if (!cancelled) setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        setStatus(error instanceof ApiError && error.httpStatus === 403 ? "denied" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  async function runAction(name: string, path: string, body: Record<string, unknown>) {
    setActionPending(name);
    setActionError(null);
    try {
      await apiFetch(path, { method: "POST", body: JSON.stringify({ organizationId, ...body }) });
      await refresh();
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : "That action could not be completed. Please try again.");
    } finally {
      setActionPending(null);
    }
  }

  if (status === "loading") return <p role="status">Loading…</p>;
  if (status === "denied") {
    return (
      <p className="form-status form-status--error" role="alert">
        You don&apos;t have permission to view this organization&apos;s billing.
      </p>
    );
  }
  if (status === "error" || !summary) {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong. Please try again.
      </p>
    );
  }

  if (summary.subscriptionStatus === "NOT_SUBSCRIBED") {
    return (
      <div style={{ display: "grid", gap: "1rem", maxWidth: "36rem" }}>
        <h2 style={{ margin: 0 }}>Billing &amp; Subscription</h2>
        <p>This organization doesn&apos;t have a Paid2You subscription yet.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1.5rem", maxWidth: "40rem" }}>
      <h2 style={{ margin: 0 }}>Billing &amp; Subscription</h2>

      {!summary.providerConfigured && (
        <p className="form-status" role="status">
          Live subscription billing isn&apos;t configured yet for this environment. You can review your plan
          and usage below, but payment-method, upgrade, and invoice actions aren&apos;t available until a
          billing provider is set up.
        </p>
      )}

      <section style={{ display: "grid", gap: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>Current plan</h3>
        <p style={{ margin: 0 }}>
          <strong>{summary.plan?.name}</strong>
          {summary.plan ? ` — ${formatMoney(summary.plan.monthlyFeeMinorUnits)}/month${summary.plan.isNegotiated ? " (negotiated)" : ""}` : ""}
        </p>
        <p style={{ margin: 0 }}>
          Status: <strong>{STATUS_LABEL[summary.subscriptionStatus]}</strong>
        </p>
        {summary.currentPeriodStart && summary.currentPeriodEnd ? (
          <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "var(--text-sm)" }}>
            Current billing period: {formatDate(summary.currentPeriodStart)} – {formatDate(summary.currentPeriodEnd)}
          </p>
        ) : null}
      </section>

      {summary.usage && summary.band ? (
        <section style={{ display: "grid", gap: "0.5rem" }}>
          <h3 style={{ margin: 0 }}>Usage this billing period</h3>
          <p style={{ margin: 0 }}>
            {summary.band.max !== null
              ? `${summary.usage.count} of ${summary.band.max} established arrangements used`
              : `${summary.usage.count} established arrangements (custom/unlimited plan)`}
          </p>
          {summary.band.max !== null && summary.usage.count >= summary.band.max ? (
            <p className="form-status" role="status">
              You&apos;ve reached this plan&apos;s limit for the current billing period. Upgrade to continue
              establishing new arrangements this period, or wait until the next billing period.
            </p>
          ) : null}
        </section>
      ) : null}

      <section style={{ display: "grid", gap: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>Payment method</h3>
        {summary.paymentMethod ? (
          <p style={{ margin: 0 }}>
            {summary.paymentMethod.displayName ?? summary.paymentMethod.paymentType}
            {summary.paymentMethod.displayLast4 ? ` •••• ${summary.paymentMethod.displayLast4}` : ""}
          </p>
        ) : (
          <p style={{ margin: 0, color: "var(--ink-soft)" }}>No payment method on file.</p>
        )}
      </section>

      <section style={{ display: "grid", gap: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>Invoices</h3>
        {summary.invoices.length === 0 ? (
          <p style={{ margin: 0, color: "var(--ink-soft)" }}>No invoices yet.</p>
        ) : (
          <ul style={{ display: "grid", gap: "0.5rem", padding: 0, margin: 0, listStyle: "none" }}>
            {summary.invoices.map((inv) => (
              <li key={inv.id} style={{ display: "flex", justifyContent: "space-between", gap: "1rem", padding: "0.5rem", border: "1px solid var(--border, #ddd)", borderRadius: "0.5rem" }}>
                <span>
                  {formatDate(inv.periodStart)} – {formatDate(inv.periodEnd)} — {formatMoney(inv.amountDueMinorUnits)} — {inv.status.replace("_", " ")}
                </span>
                {inv.status === "past_due" || inv.status === "open" ? (
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={actionPending === `pay-${inv.id}`}
                    onClick={() => void runAction(`pay-${inv.id}`, "/api/organizations/billing/pay-invoice", { invoiceId: inv.id })}
                  >
                    {actionPending === `pay-${inv.id}` ? "Processing…" : "Pay Now"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ display: "grid", gap: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>Change plan</h3>
        {summary.availableUpgrades.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {summary.availableUpgrades.map((p) => (
              <button
                key={p.code}
                type="button"
                className="button button--secondary"
                disabled={!summary.providerConfigured || actionPending === `upgrade-${p.code}`}
                onClick={() => void runAction(`upgrade-${p.code}`, "/api/organizations/billing/change-plan", { planCode: p.code })}
              >
                {actionPending === `upgrade-${p.code}` ? "Upgrading…" : `Upgrade to ${p.name}`}
              </button>
            ))}
          </div>
        ) : null}
        <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "var(--text-sm)" }}>
          Need more than 2,000 established arrangements a month? <a href="/support">Contact us about Enterprise</a>.
        </p>
        <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "var(--text-sm)" }}>
          Downgrading to a lower plan isn&apos;t available yet — <a href="/support">contact support</a> if you need
          a lower-volume plan.
        </p>
      </section>

      <section style={{ display: "grid", gap: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>Subscription</h3>
        {summary.subscriptionStatus === "CANCEL_AT_PERIOD_END" ? (
          <button type="button" className="button button--secondary" disabled={actionPending === "reactivate"} onClick={() => void runAction("reactivate", "/api/organizations/billing/reactivate", {})}>
            {actionPending === "reactivate" ? "Reactivating…" : "Reactivate subscription"}
          </button>
        ) : summary.subscriptionStatus === "ACTIVE" || summary.subscriptionStatus === "PAST_DUE" ? (
          <button type="button" className="button button--ghost" disabled={actionPending === "cancel"} onClick={() => void runAction("cancel", "/api/organizations/billing/cancel", {})}>
            {actionPending === "cancel" ? "Canceling…" : "Cancel at period end"}
          </button>
        ) : null}
      </section>

      {actionError ? (
        <p className="form-status form-status--error" role="alert">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
