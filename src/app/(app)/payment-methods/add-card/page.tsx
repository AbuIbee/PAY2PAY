import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Add debit card" };

/**
 * Phase 6A (docs/prsprints/PHASE_6A_PREPRODUCTION_FINANCIAL_UX_COMPLETION.md): card-on-file collection
 * (a card the debtor registers so PAY2PAY can charge it — Sprint 12's concept, distinct from Phase 6's
 * card-issuance domain) has no production tokenization architecture yet — the old form collected a
 * typed-in "sandbox card token" placeholder, not a real card processor integration. Per this phase's
 * own "never make a feature appear production-live merely by removing the word sandbox" rule, this
 * page now states the true current availability instead of presenting a non-functional entry form.
 */
export default function AddDebitCardPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Add debit card</h1>
      </div>
      <div className="empty-state">
        <h3>Not yet available</h3>
        <p>
          Paying by debit card isn&apos;t available for your account yet. You can connect a bank
          account today and pay by bank transfer.
        </p>
        <div className="hero__actions" style={{ marginTop: "0.5rem" }}>
          <Link href="/payment-methods/add-bank" className="button button--primary">
            Connect bank account
          </Link>
          <Link href="/payment-methods" className="button button--ghost">
            Back to payment methods
          </Link>
        </div>
      </div>
    </div>
  );
}
