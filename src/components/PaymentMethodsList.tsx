"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/ui/apiFetch";
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
  bankAccountSubtype: "checking" | "savings" | null;
  status: "pending_verification" | "verified" | "failed" | "disabled";
  createdAt: string;
}

function bankSubtypeLabel(subtype: "checking" | "savings" | null): string {
  if (subtype === "checking") return "Checking";
  if (subtype === "savings") return "Savings";
  return "Bank account";
}

type LoadState = "loading" | "ready" | "unauthorized" | "error";

function AccountCard({ account, activeProfile, onRemoved }: { account: FinancialAccountRecord; activeProfile: ActiveProfile; onRemoved: () => void }) {
  const chip = financialAccountStatusLabel(account.status);
  const title =
    account.accountType === "bank_account"
      ? account.institutionDisplayName ?? "Bank account"
      : [account.cardBrand, "card"].filter(Boolean).join(" ");
  const subtitle =
    account.accountType === "bank_account"
      ? [bankSubtypeLabel(account.bankAccountSubtype), account.maskedLast4 ? `•••• ${account.maskedLast4}` : null]
          .filter(Boolean)
          .join(" ")
      : [
          account.maskedLast4 ? `Ending in ${account.maskedLast4}` : "No card number on file",
          account.cardExpiryMonth && account.cardExpiryYear
            ? `Expires ${String(account.cardExpiryMonth).padStart(2, "0")}/${account.cardExpiryYear}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");

  const [removeStatus, setRemoveStatus] = useState<"idle" | "working" | "error">("idle");
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function handleRemove() {
    if (!window.confirm(`Remove ${title}? You won't be able to select it for new payments once it's removed.`)) return;
    setRemoveStatus("working");
    setRemoveError(null);
    try {
      await apiFetch("/api/relationships/accounts/remove", {
        method: "POST",
        body: JSON.stringify({
          financialAccountId: account.id,
          actingParty: { kind: activeProfile.kind, id: activeProfile.kind === "business" ? activeProfile.businessProfileId : activeProfile.personalProfileId },
          reason: "Removed by account holder via Payment Methods.",
        }),
      });
      onRemoved();
    } catch (error) {
      setRemoveStatus("error");
      setRemoveError(error instanceof ApiError ? error.message : "Could not remove this account. Please try again.");
    }
  }

  return (
    <div className="card">
      <div className="card__header">
        <div>
          <h3>{title}</h3>
          <p style={{ margin: "0.25rem 0 0", color: "var(--ink-soft)", fontSize: "0.85rem" }}>{subtitle}</p>
        </div>
        <span className={`chip chip--${chip.tone}`}>{chip.label}</span>
      </div>
      <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.78rem" }}>
        Added {formatDate(account.createdAt)}
      </p>
      {removeError && (
        <p className="field-error" role="alert" style={{ marginTop: "0.5rem" }}>
          {removeError}
        </p>
      )}
      <div style={{ marginTop: "0.75rem" }}>
        <button type="button" className="button button--ghost" disabled={removeStatus === "working"} onClick={() => void handleRemove()}>
          {removeStatus === "working" ? "Removing…" : "Remove"}
        </button>
      </div>
    </div>
  );
}

export function PaymentMethodsList() {
  const [state, setState] = useState<LoadState>("loading");
  const [accounts, setAccounts] = useState<FinancialAccountRecord[]>([]);
  const [activeProfile, setActiveProfile] = useState<ActiveProfile | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
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
        setActiveProfile(active);
        setAccounts(body.accounts);
        setState("ready");
      } catch (error) {
        if (cancelled) return;
        if ((error as { httpStatus?: number }).httpStatus === 401) setState("unauthorized");
        else setState("error");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

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

  if (state === "error" || !activeProfile) {
    return (
      <p className="form-status form-status--error" role="alert">
        Something went wrong loading your payment methods. Please try again.
      </p>
    );
  }

  // A removed (disabled) account is no longer a usable payment method — it drops out of this list
  // (requirement: "account disappears from usable payment methods") while its row still exists,
  // preserved for audit history, at `status: "disabled"`.
  const usableAccounts = accounts.filter((a) => a.status !== "disabled");
  const bankAccounts = usableAccounts.filter((a) => a.accountType === "bank_account");
  const cards = usableAccounts.filter((a) => a.accountType === "debit_card");

  if (usableAccounts.length === 0) {
    return (
      <div className="empty-state">
        <h3>No bank account connected</h3>
        <p>Connect a bank account so you&apos;re ready to fund or receive payments.</p>
        <div className="hero__actions" style={{ marginTop: "0.5rem" }}>
          <Link href="/payment-methods/add-bank" className="button button--primary">
            Connect bank account
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
              <AccountCard key={account.id} account={account} activeProfile={activeProfile} onRemoved={() => setReloadKey((k) => k + 1)} />
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
              <AccountCard key={account.id} account={account} activeProfile={activeProfile} onRemoved={() => setReloadKey((k) => k + 1)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
