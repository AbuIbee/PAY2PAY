import type { Metadata } from "next";
import { LegalPlaceholder } from "@/components/LegalPlaceholder";
import { CURRENT_LEGAL_DOCUMENT_VERSIONS } from "@/lib/legal/legalDocumentVersions";

export const metadata: Metadata = {
  title: "Business Subscription Policy",
};

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 5: describes the ALREADY-APPROVED
 * commercial/product rules for a Business organization's Paid2You subscription — never a refund
 * guarantee, regulatory guarantee, chargeback promise, service-level guarantee, or an automatic
 * Enterprise approval, none of which this phase approved. Where a rule is genuinely undecided (e.g.
 * the exact automated mechanics of a downgrade), this page says so plainly rather than inventing an
 * answer — see the "Changing your plan" section below. Uses the same honest, not-yet-counsel-
 * reviewed framing every other legal page in this codebase uses (LegalPlaceholder) — this documents
 * real, current product behavior, not a finished contractual document.
 */
export default function BusinessSubscriptionPolicyPage() {
  return (
    <LegalPlaceholder
      title="Business Subscription Policy"
      intro="How a Paid2You Business organization's subscription works."
      version={CURRENT_LEGAL_DOCUMENT_VERSIONS.business_subscription_policy}
    >
      <p>
        This page describes how a Paid2You Business organization&apos;s subscription currently
        works. It is not yet a complete, counsel-reviewed commercial agreement — see the Terms of
        Service for that overall caveat. It applies only to Business organization accounts;
        Personal accounts are free and are not subject to any of the subscription terms below.
      </p>

      <h2>Plans and pricing</h2>
      <ul>
        <li>Starter — $99/month — 0 to 24 established arrangements per billing month.</li>
        <li>Core — $199/month — 25 to 99 established arrangements per billing month.</li>
        <li>Growth — $699/month — 100 to 499 established arrangements per billing month.</li>
        <li>Scale — $1,999/month — 500 to 1,999 established arrangements per billing month.</li>
        <li>Enterprise — starting at $5,000/month — 2,000+ established arrangements per billing month, at a custom negotiated contract price.</li>
      </ul>
      <p>
        A Business organization is subscribed to exactly one plan at a time. A Business
        organization with zero established arrangements in a billing period remains subscribed to
        its current plan (Starter at minimum) and still owes that plan&apos;s subscription fee —
        there is no free Business plan.
      </p>

      <h2>What counts as an established arrangement</h2>
      <p>
        An established arrangement is a repayment arrangement between your organization and a
        customer that has reached its fully signed/established state. The following do NOT count:
        a draft arrangement, a proposed arrangement awaiting response, an edit to an existing
        arrangement, an invitation that has not yet been accepted, simply viewing an arrangement, an
        individual payment made toward an arrangement, or a recurring payment occurrence under an
        already-established arrangement. Each qualifying arrangement is counted exactly once, the
        first time it becomes established, regardless of how many times a request to establish it is
        retried.
      </p>

      <h2>Billing-period usage and plan/band transitions</h2>
      <p>
        Established-arrangement volume is counted per billing period and compared against your
        current plan&apos;s band. If establishing a new arrangement would exceed your current
        plan&apos;s band for the current billing period, Paid2You will not silently charge an
        overage fee and will not silently change your plan — it will tell you that you have reached
        your current plan&apos;s limit for this billing period and that moving to the next band
        requires either selecting a higher plan or waiting until the next billing period. Standard
        plans (Starter → Core → Growth → Scale) support upgrading to the next plan when a live
        billing provider is configured. Enterprise access (2,000+ established arrangements, or any
        custom contract) requires contacting Paid2You directly — it is never activated
        automatically.
      </p>

      <h2>Changing your plan</h2>
      <p>
        Upgrading to a higher plan takes effect on your current subscription immediately. Paid2You
        does not yet offer a self-service downgrade to a lower plan — this is a known, deliberate
        limitation while the corresponding billing-provider synchronization is completed, and the
        downgrade action is hidden rather than offered in a way that might not work correctly. If
        you believe your organization no longer needs its current plan, contact support.
      </p>

      <h2>Payment authorization and failed payments</h2>
      <p>
        Activating a paid Business subscription requires authorizing Paid2You to charge your
        organization&apos;s designated payment method on a recurring basis — see the Recurring
        Payment Authorization document for that authorization specifically. If a subscription
        payment fails, the related invoice is marked past due; Paid2You does not silently retry an
        unlimited number of times or silently change your plan because of a failed payment. Access
        to your organization&apos;s workspace and data is not revoked merely because one invoice is
        past due, though continued nonpayment may eventually lead to suspension of the Business
        subscription — handled case by case while this policy matures, never automatically
        destructive to your underlying data.
      </p>

      <h2>Cancellation and reactivation</h2>
      <p>
        Canceling a Business subscription takes effect at the end of the current billing period by
        default — it does not immediately terminate access. A subscription scheduled to cancel at
        period end can be reactivated before that period ends. Canceling your Business subscription
        does not delete your organization&apos;s existing records (agreements, customers, balances,
        audit history); it stops future billing and, once the subscription period actually ends,
        stops access to subscription-gated functionality until a new subscription is started.
      </p>

      <h2>Enterprise contractual pricing</h2>
      <p>
        Enterprise pricing and any arrangement-volume terms beyond 2,000/month are negotiated
        directly and may differ from the starting reference price shown above. A negotiated
        Enterprise price or limit applies only once Paid2You has specifically configured it for your
        organization — it is never inferred or approved automatically.
      </p>

      <h2>Provider-dependent processing</h2>
      <p>
        Subscription billing (charging your payment method, generating invoices) is processed
        through a third-party billing provider, not by Paid2You directly. If no live billing
        provider is configured for your environment, subscription activation and payment-method
        setup are unavailable, and Paid2You will say so plainly rather than claiming a payment
        method was saved or a subscription was activated when it was not.
      </p>
    </LegalPlaceholder>
  );
}
