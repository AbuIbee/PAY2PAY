import Link from "next/link";

/**
 * Phase 6A (docs/prsprints/PHASE_6A_PREPRODUCTION_FINANCIAL_UX_COMPLETION.md) CARDS UI CLEANUP: PAY2PAY
 * card issuance (built in Phase 6/PRSprint 24) has exactly one provider implementation registered — a
 * sandbox mock — and live card issuance remains a separately Product-Owner-gated activation (see
 * docs/PRODUCTION_PROVIDER_READINESS.md). Per this phase's own explicit rule ("never make a feature
 * appear production-live merely by removing the word sandbox"), the request/activate/freeze/cancel flow
 * built in Phase 6 is not shown to customers here — a customer requesting a "card" today would receive
 * one that can never be used for a real purchase, which is not an honest experience even without the
 * word "sandbox" attached to it. The full CardService/CardWebhookService/API-route architecture built
 * in Phase 6 is untouched and unweakened; only this customer-facing surface is gated until a real
 * card-issuing provider is selected and activated.
 */
export function CardsManager() {
  return (
    <div className="empty-state">
      <h3>Not yet available</h3>
      <p>Card services are not yet available for this account. We&apos;ll let you know when they are.</p>
      <div className="hero__actions" style={{ marginTop: "0.5rem" }}>
        <Link href="/payment-methods" className="button button--primary">
          View payment methods
        </Link>
      </div>
    </div>
  );
}
