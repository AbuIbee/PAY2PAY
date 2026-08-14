"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatDate } from "@/lib/ui/date";
import { financialAccountStatusLabel } from "@/lib/ui/statusLabels";

interface ActiveProfile {
  kind: "personal" | "business";
  personalProfileId?: string;
  businessProfileId?: string;
}

interface FinancialAccountRecord {
  id: string;
  accountType: "bank_account" | "debit_card";
  providerName: string;
  maskedLast4: string | null;
  institutionDisplayName: string | null;
  cardExpiryMonth: number | null;
  cardExpiryYear: number | null;
  cardBrand: string | null;
  status: "pending_verification" | "verified" | "failed" | "disabled";
  createdAt: string;
}

type LoadState = "loading" | "ready" | "unauthorized" | "error";

function AccountCard({ account }: { account: FinancialAccountRecord }) {
  const chip = financialAccountStatusLabel(account.status);
  const title =
    account.accountType === "bank_account"
      ? account.institutionDisplayName ?? "Bank account"
      : [account.cardBrand, "card"].filter(Boolean).join(" ");
  return (
    <div className="card">
      <div className="card__header">
        <div>
          <h3>{title}</h3>
          <p style={{ margin: "0.25rem 0 0", color: "var(--ink-soft)", fontSize: "0.85rem" }}>
            {account.maskedLast4 ? `Ending in ${account.maskedLast4}` : "No card number on file"}
            {account.accountType === "debit_card" && account.cardExpiryMonth && account.cardExpiryYear
              ? ` · Expires ${String(account.cardExpiryMonth).padStart(2, "0")}/${account.cardExpiryYear}`
              : null}
          </p>
        </div>
        <span className={`chip chip--${chip.tone}`}>{chip.label}</span>
      </div>
      <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.78rem" }}>
        Added {formatDate(account.createdAt)}
      </p>
    </div>
  );
}

export function PaymentMethodsList() {
  const [state, setState] = useState<LoadState>("loading");
  const [accounts, setAccounts] = useState<FinancialAccountRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const active = await apiFetch<ActiveProfile>("/api/profiles/active");
        const partyKind = active.kind;
        const partyId = active.kind === "business" ? active.businessProfileId : active.personalProfileId;
        if (!partyId) {
          if (!cancelled) setState("error");
          return;
        }
        const body = await apiFetch<{ accounts: FinancialAccountRecord[] }>(
          `/api/relationships/accounts/party?partyKind=${partyKind}&partyId=${partyId}`,
        );
        if (cancelled) return;
        setAccounts(body.accounts);
        setState("ready");
      } catch (error) {
        if (cancelled) return;
        if ((error as { httpStatus?: number }).httpStatus === 401) setState("unauthorized");
        else setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading") {
    return (
      <div className="card-grid">
        <div className="skeleton skeleton--card" />
        <div className="skeleton skeleton--card" />
      </div>
    );
  }

  if (state === "unauthorized") {
    return (
      <p className="form-status form-status--error" role="alert">
        You need to <Link href="/login">sign in</Link> to view your payment methods.
      </p>
    );
  }

  if (state === "error") {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong loading your payment methods. Please try again.
      </p>
    );
  }

  const bankAccounts = accounts.filter((a) => a.accountType === "bank_account");
  const cards = accounts.filter((a) => a.accountType === "debit_card");

  if (accounts.length === 0) {
    return (
      <div className="empty-state">
        <h3>No payment methods yet</h3>
        <p>Add a bank account or debit card so you&apos;re ready to fund or receive payments.</p>
        <div className="hero__actions" style={{ marginTop: "0.5rem" }}>
          <Link href="/payment-methods/add-bank" className="button button--primary">
            Add bank account
          </Link>
          <Link href="/payment-methods/add-card" className="button button--ghost">
            Add debit card
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "2rem" }}>
      <section>
        <h2 style={{ fontSize: "1rem" }}>Bank accounts</h2>
        {bankAccounts.length === 0 ? (
          <p style={{ color: "var(--ink-soft)" }}>No bank accounts on file.</p>
        ) : (
          <div className="card-grid">
            {bankAccounts.map((account) => (
              <AccountCard key={account.id} account={account} />
            ))}
          </div>
        )}
      </section>
      <section>
        <h2 style={{ fontSize: "1rem" }}>Debit cards</h2>
        {cards.length === 0 ? (
          <p style={{ color: "var(--ink-soft)" }}>No debit cards on file.</p>
        ) : (
          <div className="card-grid">
            {cards.map((account) => (
              <AccountCard key={account.id} account={account} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
