"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "@/lib/ui/apiFetch";
import { formatMoney } from "@/lib/ui/money";
import { formatDate } from "@/lib/ui/date";
import { paymentAttemptStatusLabel } from "@/lib/ui/statusLabels";

interface ActiveProfile {
  kind: "personal" | "business";
  personalProfileId?: string;
  businessProfileId?: string;
  displayName: string;
}

interface AgreementSummary {
  id: string;
  status: string;
  currency: string;
  relationshipShape: "P2P" | "B2C" | "C2B" | "B2B";
  createdAt: string;
}

interface PaymentAttempt {
  id: string;
  status: string;
  amountMinorUnits: number;
  currency: string;
  agreementId: string | null;
  payerProfileKind: "personal" | "business";
  payerProfileId: string;
  recipientProfileKind: "personal" | "business";
  recipientProfileId: string;
  installmentScheduleItemId: string | null;
  paymentMethod: "ach" | "debit_card" | null;
  createdAt: string;
}

type LoadStatus = "loading" | "ready" | "unauthorized" | "error";

function activeProfileId(profile: ActiveProfile): string | undefined {
  return profile.kind === "personal" ? profile.personalProfileId : profile.businessProfileId;
}

export function PaymentsList() {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [payments, setPayments] = useState<PaymentAttempt[]>([]);
  const [active, setActive] = useState<ActiveProfile | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const activeProfile = await apiFetch<ActiveProfile>("/api/profiles/active");
        if (cancelled) return;
        setActive(activeProfile);
        const id = activeProfileId(activeProfile);
        if (!id) {
          setStatus("ready");
          return;
        }
        const { agreements } = await apiFetch<{ agreements: AgreementSummary[] }>(
          `/api/agreements?profileKind=${activeProfile.kind}&profileId=${id}`,
        );
        const perAgreement = await Promise.all(
          agreements.map((agreement) =>
            apiFetch<{ payments: PaymentAttempt[] }>(`/api/payments/by-agreement?agreementId=${agreement.id}`).then(
              (body) => body.payments,
            ),
          ),
        );
        if (cancelled) return;
        const merged = perAgreement.flat().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setPayments(merged);
        setStatus("ready");
      } catch (error: unknown) {
        if (cancelled) return;
        if (error instanceof ApiError && error.httpStatus === 401) {
          setStatus("unauthorized");
        } else {
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "loading") {
    return (
      <div className="table-wrap">
        <div style={{ padding: "1.5rem" }}>
          <div className="skeleton skeleton--line" style={{ width: "60%" }} />
          <div className="skeleton skeleton--line" style={{ width: "80%" }} />
          <div className="skeleton skeleton--line" style={{ width: "40%" }} />
        </div>
      </div>
    );
  }

  if (status === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert">
        You need to <a href="/login">sign in</a> to view your payments.
      </p>
    );
  }

  if (status === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong loading your payments. Please try again.
      </p>
    );
  }

  if (payments.length === 0) {
    return (
      <div className="empty-state">
        <h3>No payments yet</h3>
        <p>Payments will appear here once an agreement becomes active and installments are scheduled.</p>
      </div>
    );
  }

  const activeId = active ? activeProfileId(active) : undefined;

  return (
    <div className="table-wrap table-wrap--responsive-cards">
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Direction</th>
            <th>Amount</th>
            <th>Method</th>
            <th>Status</th>
            <th>Agreement</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((payment) => {
            const isPayer = payment.payerProfileId === activeId;
            const direction = isPayer ? "You paid" : "You received";
            const { label, tone } = paymentAttemptStatusLabel(payment.status as never);
            return (
              <tr key={payment.id}>
                <td data-label="Date">
                  <Link className="table-row-link" href={`/payments/detail?id=${payment.id}`}>
                    {formatDate(payment.createdAt)}
                  </Link>
                </td>
                <td data-label="Direction">{direction}</td>
                <td data-label="Amount">{formatMoney(payment.amountMinorUnits, payment.currency)}</td>
                <td data-label="Method">{payment.paymentMethod === "ach" ? "Bank account" : payment.paymentMethod === "debit_card" ? "Debit card" : "—"}</td>
                <td data-label="Status">
                  <span className={`chip chip--${tone}`}>{label}</span>
                </td>
                <td data-label="Agreement">
                  {payment.agreementId ? (
                    <Link href={`/agreements/detail?id=${payment.agreementId}`}>View agreement</Link>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
