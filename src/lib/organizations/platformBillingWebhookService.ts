import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError } from "@/lib/errors";
import type { BusinessProfileRepository } from "@/lib/profiles/businessProfileService";
import type { SubscriptionRepository } from "@/lib/pricing/pricingService";
import { advanceBusinessOnboardingStepIfNeeded } from "./businessOnboardingStepOrder";
import { PLATFORM_BILLING_AUDIT_ACTION, platformBillingAuditPayload } from "./platformBillingService";
import type { PlatformBillingProvider } from "./platformBillingProvider";
import type { PlatformBillingWebhookEventRepository } from "./platformBillingWebhookEventRepository";
import type { SubscriptionInvoiceRepository } from "./subscriptionInvoiceRepository";
import type { SubscriptionPaymentMethodRepository } from "./subscriptionPaymentMethodRepository";

export type ReceivePlatformBillingWebhookResult = { status: "processed" | "duplicate" | "ignored" };

function toDate(unixSeconds: unknown, fallback: Date): Date {
  return typeof unixSeconds === "number" ? new Date(unixSeconds * 1000) : fallback;
}

/** "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-3: identical rationale to BusinessVerificationWebhookService's own EVENT_CLAIM_STALE_MS. */
const EVENT_CLAIM_STALE_MS = 2 * 60 * 1000;

/**
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 24-28: the Stripe Billing webhook counterpart to
 * KycWebhookService/BusinessVerificationWebhookService — identical signature-verification ->
 * duplicate-event-protection -> processing shape. Synchronizes Stripe's own event payload directly
 * (Stripe's documented best practice, unlike the Middesk adapter's "always re-fetch" choice — a
 * Stripe webhook event's `data.object` IS the authoritative current state Stripe itself just
 * computed, not a bare notification-to-go-re-check) into the existing local
 * subscription/subscription_invoice domain — never fabricates a `paid`/`active` state the event
 * itself did not report (Section 23/28's own "never report payment succeeded without provider
 * confirmation"). Cross-tenant-safe by construction: every lookup below resolves the local
 * organization/subscription via a TRUSTED provider reference already stored from a prior
 * ensureCustomer/startSubscription call — never a client- or payload-supplied organizationId.
 *
 * "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-3: duplicate-event protection is now
 * claim-based (`events.claimEvent`), not insertion-based — a delivery is only ever a "duplicate" once
 * it actually finished processing; a provider's retry of a delivery whose first attempt failed is
 * safely reprocessed instead of being permanently suppressed. See `EVENT_CLAIM_STALE_MS`'s own doc
 * comment for the exact mechanism.
 */
export class PlatformBillingWebhookService {
  constructor(
    private readonly deps: {
      provider: PlatformBillingProvider;
      events: PlatformBillingWebhookEventRepository;
      subscriptions: SubscriptionRepository;
      invoices: SubscriptionInvoiceRepository;
      paymentMethods: SubscriptionPaymentMethodRepository;
      audit: AuditService;
      /** Used only to advance the onboarding step marker on checkout completion — see `syncCheckoutCompleted`'s own doc comment. */
      businessProfiles: BusinessProfileRepository;
    },
  ) {}

  async receiveWebhook(input: { rawBody: string; signatureHeader: string }): Promise<ReceivePlatformBillingWebhookResult> {
    const signatureValid = this.deps.provider.verifyWebhookSignature(input.rawBody, input.signatureHeader);
    if (!signatureValid) {
      throw new ForbiddenError("Webhook signature verification failed.");
    }

    const parsed = this.deps.provider.parseWebhookEvent(input.rawBody);

    const claimed = await this.deps.events.claimEvent({
      provider: parsed.provider,
      providerEventId: parsed.providerEventId,
      eventType: parsed.eventType,
      signatureVerified: true,
      payload: parsed.data,
      staleClaimMs: EVENT_CLAIM_STALE_MS,
    });
    if (!claimed) {
      return { status: "duplicate" };
    }

    const applied = await this.applyEvent(parsed.eventType, parsed.data);
    await this.deps.events.markProcessed(claimed.id);
    return { status: applied ? "processed" : "ignored" };
  }

  private async applyEvent(eventType: string, data: Record<string, unknown>): Promise<boolean> {
    switch (eventType) {
      case "checkout.session.completed":
        return this.syncCheckoutCompleted(data);
      case "customer.subscription.updated":
      case "customer.subscription.created":
        return this.syncSubscriptionPeriod(data);
      case "customer.subscription.deleted":
        return this.syncSubscriptionCanceled(data);
      case "invoice.paid":
        return this.syncInvoicePaid(data);
      case "invoice.payment_failed":
        return this.syncInvoicePastDue(data);
      default:
        // Unmapped event (e.g. payment_method.attached, customer.updated) — no-op, not an error,
        // mirrors KycWebhookService's identical "unmapped event" precedent. Still durably recorded
        // in platform_billing_webhook_event above for audit/observability.
        return false;
    }
  }

  /**
   * "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 7/9/10: the ONLY place a hosted
   * checkout session's outcome is ever trusted — never the browser redirect
   * (`PlatformBillingService.beginHostedCheckout`'s own doc comment). Resolves the local subscription
   * row via the session's `customer` field — a TRUSTED provider reference this application itself
   * persisted onto that row before ever redirecting the Business to the hosted page (never a
   * client-/payload-supplied organization id). Re-fetches the real payment method and subscription
   * period from the provider directly (Section 23's own "never fabricate a confirmed state the event
   * itself did not report" extended here to "even the event's own fields are re-verified against the
   * provider, not blindly trusted") rather than trusting the checkout session payload's own fields for
   * anything beyond routing. A session delivered twice for the same organization (a Business
   * completing checkout more than once) still only ever records ONE safe "active payment method"
   * locally, since `findActiveForOrganization`/`insert` below mirror `PlatformBillingService.setUpBilling`'s
   * own existing (already cross-tenant-tested) persistence shape exactly.
   */
  private async syncCheckoutCompleted(data: Record<string, unknown>): Promise<boolean> {
    const providerCustomerReference = typeof data.customer === "string" ? data.customer : null;
    const providerSubscriptionReference = typeof data.subscription === "string" ? data.subscription : null;
    if (!providerCustomerReference || !providerSubscriptionReference) return false;

    const sub = await this.deps.subscriptions.findByProviderCustomerReference(providerCustomerReference);
    if (!sub) return false;

    const [state, paymentMethod] = await Promise.all([
      this.deps.provider.retrieveSubscriptionState(providerSubscriptionReference),
      this.deps.provider.retrieveSubscriptionPaymentMethod(providerSubscriptionReference),
    ]);

    // "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-4: `checkout.session.completed` proves
    // only that the hosted Checkout FLOW completed — it does NOT independently prove Paid2You
    // subscription eligibility (Section 16/17's own explicit rule). References/period/payment-method
    // are still synced unconditionally below (so a LATER legitimate event — e.g.
    // `customer.subscription.updated` — can still correlate this provider subscription back to this
    // local row, and so the Billing page can honestly show whatever real state the provider reports,
    // including a failed/incomplete one), but activation-grade consequences — advancing the onboarding
    // step (one of `BusinessActivationService`'s four independent required facts) and the
    // SUBSCRIPTION_ACTIVATED audit event — happen ONLY when the provider's own authoritative state is
    // genuinely eligible. Paid2You has no approved free-trial product, so "active" is the only eligible
    // Stripe state for standard launch; everything else (canceled/incomplete/incomplete_expired/
    // past_due/unpaid/paused, all of which `mapStripeSubscriptionStatus` maps to something other than
    // "active") must never activate.
    const isEligibleForActivation = state.status === "active";

    await this.deps.subscriptions.setProviderReferences(sub.id, { providerCustomerReference, providerSubscriptionReference });
    await this.deps.subscriptions.setBillingPeriod(sub.id, { currentPeriodStart: state.currentPeriodStart, currentPeriodEnd: state.currentPeriodEnd });
    await this.deps.paymentMethods.insert({
      organizationId: sub.profileId,
      provider: this.deps.provider.providerName,
      providerCustomerReference,
      providerPaymentMethodReference: paymentMethod.providerPaymentMethodReference,
      paymentType: paymentMethod.paymentType,
      displayLast4: paymentMethod.displayLast4,
      displayName: paymentMethod.displayName,
    });
    await this.syncInvoicesFor(sub.id, sub.profileId, providerSubscriptionReference);

    if (isEligibleForActivation) {
      await this.activateOnboardingIfNeeded(sub.profileId, state.status);
    }
    return true;
  }

  /**
   * "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-4: the ONE place the onboarding step is
   * ever advanced to `billing_setup_complete` and `SUBSCRIPTION_ACTIVATED` is ever audited — called
   * only once the caller has already confirmed the provider's own authoritative state is "active".
   * `advanceBusinessOnboardingStepIfNeeded` is itself monotonic/idempotent, but the audit event is NOT
   * naturally idempotent on its own, so this method only records it the first time (the profile's
   * onboarding step is not yet `billing_setup_complete`) — a later eligible event for an
   * already-activated organization (e.g. a redundant `customer.subscription.updated`) is a safe no-op.
   */
  private async activateOnboardingIfNeeded(organizationId: string, providerStatus: string): Promise<void> {
    const profile = await this.deps.businessProfiles.findById(organizationId);
    if (!profile || profile.onboardingStep === "billing_setup_complete") return;
    await advanceBusinessOnboardingStepIfNeeded(this.deps.businessProfiles, organizationId, profile.onboardingStep, "billing_setup_complete");
    await this.deps.audit.record(
      platformBillingAuditPayload({
        actorUserId: null,
        actorRole: "stripe_webhook",
        organizationId,
        action: PLATFORM_BILLING_AUDIT_ACTION.SUBSCRIPTION_ACTIVATED,
        newValue: { status: providerStatus, provider: this.deps.provider.providerName },
      }),
    );
  }

  private async syncInvoicesFor(subscriptionId: string, organizationId: string, providerSubscriptionReference: string): Promise<void> {
    const providerInvoices = await this.deps.provider.listInvoices(providerSubscriptionReference);
    for (const inv of providerInvoices) {
      const existing = await this.deps.invoices.findByProviderInvoiceReference(inv.providerInvoiceReference);
      if (existing) continue;
      await this.deps.invoices.insert({
        organizationId,
        subscriptionId,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
        amountDueMinorUnits: inv.amountDueMinorUnits,
        dueAt: inv.dueAt,
        providerInvoiceReference: inv.providerInvoiceReference,
      });
    }
  }

  private async resolveSubscription(data: Record<string, unknown>) {
    const providerSubscriptionReference = typeof data.id === "string" ? data.id : null;
    if (!providerSubscriptionReference) return null;
    return this.deps.subscriptions.findByProviderSubscriptionReference(providerSubscriptionReference);
  }

  /**
   * "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-4 (Section 17's own "allow later
   * legitimate provider event... to activate once authoritative provider state becomes eligible"):
   * `checkout.session.completed` may have synced provider references for a subscription that was not
   * yet eligible for activation (e.g. still `incomplete`, awaiting 3-D Secure) — this is the event that
   * later reports it becoming genuinely eligible. Re-fetches the authoritative state from the provider
   * directly (never trusts `data.status`/any other webhook-payload field as the activation decision —
   * same "always re-verify via the provider's own typed interface" rule `syncCheckoutCompleted` already
   * follows) before ever advancing onboarding/auditing activation.
   */
  private async syncSubscriptionPeriod(data: Record<string, unknown>): Promise<boolean> {
    const sub = await this.resolveSubscription(data);
    if (!sub) return false;
    const now = new Date();
    await this.deps.subscriptions.setBillingPeriod(sub.id, {
      currentPeriodStart: toDate(data.current_period_start, now),
      currentPeriodEnd: toDate(data.current_period_end, now),
    });

    const providerSubscriptionReference = typeof data.id === "string" ? data.id : null;
    if (providerSubscriptionReference) {
      try {
        const state = await this.deps.provider.retrieveSubscriptionState(providerSubscriptionReference);
        if (state.status === "active") {
          await this.activateOnboardingIfNeeded(sub.profileId, state.status);
        }
      } catch {
        // Best-effort activation check only — the billing-period sync above already succeeded and is
        // the required effect of this event; a failed re-fetch here must never fail (or roll back)
        // that already-applied, independently correct update. A LATER event (another period update,
        // or a direct checkout-completion sync) still gets its own chance to activate once eligible.
      }
    }
    return true;
  }

  private async syncSubscriptionCanceled(data: Record<string, unknown>): Promise<boolean> {
    const sub = await this.resolveSubscription(data);
    if (!sub) return false;
    await this.deps.subscriptions.cancel(sub.id);
    return true;
  }

  private async resolveInvoiceContext(data: Record<string, unknown>) {
    const providerSubscriptionReference = typeof data.subscription === "string" ? data.subscription : null;
    if (!providerSubscriptionReference) return null;
    const sub = await this.deps.subscriptions.findByProviderSubscriptionReference(providerSubscriptionReference);
    return sub ? { sub } : null;
  }

  private async syncInvoicePaid(data: Record<string, unknown>): Promise<boolean> {
    const context = await this.resolveInvoiceContext(data);
    if (!context) return false;
    const providerInvoiceReference = typeof data.id === "string" ? data.id : null;
    if (!providerInvoiceReference) return false;

    const existing = await this.deps.invoices.findByProviderInvoiceReference(providerInvoiceReference);
    const amountPaid = typeof data.amount_paid === "number" ? data.amount_paid : 0;
    const paidAt = new Date();
    if (existing) {
      if (existing.status !== "paid") {
        await this.deps.invoices.markPaid(existing.id, { amountPaidMinorUnits: amountPaid, paidAt });
      }
      return true;
    }
    const inserted = await this.deps.invoices.insert({
      organizationId: context.sub.profileId,
      subscriptionId: context.sub.id,
      periodStart: toDate(data.period_start, paidAt),
      periodEnd: toDate(data.period_end, paidAt),
      amountDueMinorUnits: typeof data.amount_due === "number" ? data.amount_due : amountPaid,
      dueAt: toDate(data.due_date, paidAt),
      providerInvoiceReference,
    });
    await this.deps.invoices.markPaid(inserted.id, { amountPaidMinorUnits: amountPaid, paidAt });
    return true;
  }

  private async syncInvoicePastDue(data: Record<string, unknown>): Promise<boolean> {
    const context = await this.resolveInvoiceContext(data);
    if (!context) return false;
    const providerInvoiceReference = typeof data.id === "string" ? data.id : null;
    if (!providerInvoiceReference) return false;

    const existing = await this.deps.invoices.findByProviderInvoiceReference(providerInvoiceReference);
    const now = new Date();
    if (existing) {
      if (existing.status !== "paid") {
        await this.deps.invoices.markStatus(existing.id, "past_due");
        await this.recordPaymentFailedAudit(context.sub.profileId, providerInvoiceReference);
      }
      return true;
    }
    const inserted = await this.deps.invoices.insert({
      organizationId: context.sub.profileId,
      subscriptionId: context.sub.id,
      periodStart: toDate(data.period_start, now),
      periodEnd: toDate(data.period_end, now),
      amountDueMinorUnits: typeof data.amount_due === "number" ? data.amount_due : 0,
      dueAt: toDate(data.due_date, now),
      providerInvoiceReference,
    });
    await this.deps.invoices.markStatus(inserted.id, "past_due");
    await this.recordPaymentFailedAudit(context.sub.profileId, providerInvoiceReference);
    return true;
  }

  private async recordPaymentFailedAudit(organizationId: string, providerInvoiceReference: string): Promise<void> {
    await this.deps.audit.record(
      platformBillingAuditPayload({
        actorUserId: null,
        actorRole: "stripe_webhook",
        organizationId,
        action: PLATFORM_BILLING_AUDIT_ACTION.PAYMENT_FAILED,
        newValue: { providerInvoiceReference, status: "past_due" },
      }),
    );
  }
}
