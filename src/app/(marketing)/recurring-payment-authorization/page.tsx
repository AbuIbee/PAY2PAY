import type { Metadata } from "next";
import { LegalPlaceholder } from "@/components/LegalPlaceholder";
import { CURRENT_LEGAL_DOCUMENT_VERSIONS } from "@/lib/legal/legalDocumentVersions";

export const metadata: Metadata = {
  title: "Recurring Payment Authorization",
};

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 7: the Paid2You SUBSCRIPTION
 * recurring-charge authorization specifically — deliberately, conceptually separate from an ordinary
 * customer repayment agreement between a Business organization and ITS OWN customers (which has its
 * own, entirely unrelated authorization inside the agreement flow itself). This document is about
 * Paid2You charging the Business for its OWN subscription, never about a Business's customer
 * repayments.
 */
export default function RecurringPaymentAuthorizationPage() {
  return (
    <LegalPlaceholder
      title="Recurring Payment Authorization"
      intro="Your authorization for Paid2You's own recurring Business subscription charge."
      version={CURRENT_LEGAL_DOCUMENT_VERSIONS.recurring_payment_authorization}
    >
      <p>
        This authorization covers ONLY the recurring subscription fee your Business organization
        pays Paid2You for use of the Paid2You Business product, under the plan described in the
        Business Subscription Policy. It is entirely separate from, and has nothing to do with, any
        repayment arrangement between your organization and your own customers — those are
        authorized independently, inside each individual arrangement.
      </p>

      <h2>What you are authorizing</h2>
      <p>
        By accepting this authorization, the Business owner or authorized billing administrator
        confirms that Paid2You is authorized to charge the organization&apos;s designated payment
        method, on a recurring monthly basis, for the organization&apos;s current Business
        subscription plan&apos;s fee, until the subscription is canceled in accordance with the
        Business Subscription Policy. This authorization is recorded against your organization,
        with the exact version of this document and the time it was accepted.
      </p>

      <h2>When a payment method is actually attached</h2>
      <p>
        Accepting this authorization is a legal/administrative step and is independent of whether a
        real payment method has actually been attached yet. Paid2You does not collect your raw card
        or bank account details directly — that is handled by our billing provider&apos;s own
        secure collection process, once a live billing provider is configured for your environment.
        If no live billing provider is configured, you may still review and accept this
        authorization, but Paid2You will not claim that a payment method has been saved or that your
        subscription has been activated until a real provider has actually confirmed it.
      </p>

      <h2>Failed charges</h2>
      <p>
        If a recurring charge under this authorization fails, Paid2You will mark the related invoice
        past due rather than silently retrying an unlimited number of times or silently changing
        your organization&apos;s plan — see the Business Subscription Policy for what happens next.
      </p>

      <h2>Withdrawing this authorization</h2>
      <p>
        You may withdraw this authorization at any time by canceling your Business subscription.
        Cancellation takes effect at the end of the current billing period by default, consistent
        with the Business Subscription Policy.
      </p>
    </LegalPlaceholder>
  );
}
