import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ConflictError, DependencyError, ValidationError } from "@/lib/errors";
import type { PricingPlanRepository } from "@/lib/pricing/pricingService";
import type { SubscriptionRecord, SubscriptionRepository } from "@/lib/pricing/pricingService";
import type { PlatformBillingProvider } from "./platformBillingProvider";
import type { SubscriptionInvoiceRecord, SubscriptionInvoiceRepository } from "./subscriptionInvoiceRepository";
import type { SubscriptionPaymentMethodRecord, SubscriptionPaymentMethodRepository } from "./subscriptionPaymentMethodRepository";

/**
 * "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 8-C: SCREAMING_SNAKE_CASE, mirrors
 * `BUSINESS_VERIFICATION_AUDIT_ACTION`'s own established naming convention (businessVerificationService.ts).
 */
export const PLATFORM_BILLING_AUDIT_ACTION = {
  SUBSCRIPTION_STARTED: "PLATFORM_SUBSCRIPTION_STARTED",
  SUBSCRIPTION_ACTIVATED: "PLATFORM_SUBSCRIPTION_ACTIVATED",
  PAYMENT_FAILED: "PLATFORM_SUBSCRIPTION_PAYMENT_FAILED",
  CANCEL_AT_PERIOD_END: "PLATFORM_SUBSCRIPTION_CANCEL_AT_PERIOD_END",
  REACTIVATED: "PLATFORM_SUBSCRIPTION_REACTIVATED",
  PLAN_UPGRADED: "PLATFORM_SUBSCRIPTION_PLAN_UPGRADED",
} as const;

/** Shared by PlatformBillingService and PlatformBillingWebhookService — identical shape to BusinessVerificationService's own `auditPayload` helper, never a second competing audit mechanism. */
export function platformBillingAuditPayload(input: {
  actorUserId: string | null;
  actorRole: string;
  organizationId: string;
  action: string;
  newValue: unknown;
  previousValue?: unknown;
  providerEventId?: string | null;
}) {
  return {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    profileKind: "business" as const,
    profileId: input.organizationId,
    agreementId: null,
    action: input.action,
    occurredAt: new Date().toISOString(),
    ipAddress: null,
    deviceInfo: null,
    previousValue: input.previousValue ?? null,
    newValue: input.newValue,
    reason: null,
    authStrength: null,
    relatedDocumentId: null,
    relatedCaseId: null,
    providerEventId: input.providerEventId ?? null,
  };
}

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 10/19-27: Paid2You's OWN recurring-billing
 * domain service — organization subscription/invoice/payment-method state ONLY. This class
 * deliberately never imports or touches `agreement`/`payment_attempt`/any customer-money-movement
 * table (Requirement 20/21/39's "do not create an ordinary customer repayment arrangement between
 * Paid2You and each subscriber" / "remain separate... in domain model... payment destination").
 *
 * Every operation that requires a LIVE provider call (attaching a payment method, starting a
 * subscription, paying an invoice, changing plan) lets `ProviderNotAvailableError`/`ConfigurationError`
 * propagate straight through when `getPlatformBillingProvider()` has nothing registered — never
 * fabricates a successful charge (Section 10/22). Cancellation/reactivation are local-first
 * (Requirement 24/25 do not condition "can cancel" on a live provider existing) and only best-effort
 * notify the provider, mirroring this codebase's established "a secondary side-effect's failure
 * never fails the primary state change" pattern (see AgreementService's own `notifyParty`).
 */
export interface BillingSummary {
  subscription: SubscriptionRecord;
  paymentMethod: SubscriptionPaymentMethodRecord | null;
  invoices: SubscriptionInvoiceRecord[];
}

export class PlatformBillingService {
  constructor(
    private readonly provider: PlatformBillingProvider,
    private readonly subscriptions: SubscriptionRepository,
    private readonly plans: PricingPlanRepository,
    private readonly invoices: SubscriptionInvoiceRepository,
    private readonly paymentMethods: SubscriptionPaymentMethodRepository,
    private readonly audit: AuditService,
  ) {}

  private async requireActiveSubscription(organizationId: string): Promise<SubscriptionRecord> {
    const sub = await this.subscriptions.findActiveByProfile("business", organizationId);
    if (!sub) throw new ValidationError("This organization has no active Paid2You subscription.");
    return sub;
  }

  /**
   * Requirement 4: the "subscription payment method / authorization" onboarding step. Requires a
   * `subscription` row to already exist (created by `PricingService.subscribe` during tier
   * selection) — this method only ever attaches the PROVIDER-side billing relationship to it, never
   * creates the subscription row itself.
   */
  async setUpBilling(input: {
    organizationId: string;
    billingEmail: string;
    legalName: string;
    paymentMethodToken: string;
  }): Promise<BillingSummary> {
    const sub = await this.requireActiveSubscription(input.organizationId);
    const plan = await this.plans.findById(sub.pricingPlanId);
    if (!plan) throw new ValidationError("This subscription's pricing plan no longer exists.");

    const customer = await this.provider.ensureCustomer({ organizationId: input.organizationId, billingEmail: input.billingEmail, legalName: input.legalName });
    const attached = await this.provider.attachPaymentMethod({ providerCustomerReference: customer.providerCustomerReference, paymentMethodToken: input.paymentMethodToken });
    await this.paymentMethods.insert({
      organizationId: input.organizationId,
      provider: this.provider.providerName,
      providerCustomerReference: customer.providerCustomerReference,
      providerPaymentMethodReference: attached.providerPaymentMethodReference,
      paymentType: attached.paymentType,
      displayLast4: attached.displayLast4,
      displayName: attached.displayName,
    });

    const started = await this.provider.startSubscription({
      providerCustomerReference: customer.providerCustomerReference,
      providerPaymentMethodReference: attached.providerPaymentMethodReference,
      planCode: plan.code,
    });
    await this.subscriptions.setProviderReferences(sub.id, {
      providerCustomerReference: customer.providerCustomerReference,
      providerSubscriptionReference: started.providerSubscriptionReference,
    });
    await this.subscriptions.setBillingPeriod(sub.id, { currentPeriodStart: started.currentPeriodStart, currentPeriodEnd: started.currentPeriodEnd });

    await this.syncInvoices(input.organizationId, sub.id, started.providerSubscriptionReference);

    await this.audit.record(
      platformBillingAuditPayload({
        actorUserId: null,
        actorRole: "business_staff",
        organizationId: input.organizationId,
        action: PLATFORM_BILLING_AUDIT_ACTION.SUBSCRIPTION_STARTED,
        newValue: { provider: this.provider.providerName, planCode: plan.code },
      }),
    );

    return this.getBillingSummary(input.organizationId);
  }

  /**
   * "PAID2YOU — MASTER P0 CLOSURE REMEDIATION" (2026-10-03), Section 7/8-D: the real hosted-checkout
   * initial-billing entry point. Returns a provider-hosted URL to redirect the Business to — this
   * method NEVER attaches a payment method or starts a subscription itself (Section 10's own "a
   * success_url redirect is UX only, never evidence of successful payment"); only
   * `PlatformBillingWebhookService`'s own `checkout.session.completed` handling, triggered by a
   * verified webhook delivery, does that. Reuses (never recreates) an existing provider customer
   * reference when one is already on this subscription row — Section 11's own idempotent-customer-
   * mapping requirement, extended here to the checkout entry point specifically. Rejects Enterprise
   * explicitly (Section 21's own "reject an attempt to self-enroll Enterprise through the normal
   * standard-plan route") with a clear ValidationError rather than relying only on the adapter's
   * incidental "no Price ID configured" ConfigurationError.
   */
  async beginHostedCheckout(input: {
    organizationId: string;
    billingEmail: string;
    legalName: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ hostedUrl: string }> {
    const sub = await this.requireActiveSubscription(input.organizationId);
    const plan = await this.plans.findById(sub.pricingPlanId);
    if (!plan) throw new ValidationError("This subscription's pricing plan no longer exists.");
    if (plan.code === "paid2you_business_enterprise") {
      throw new ValidationError("Enterprise plans are not available for self-service checkout — contact Paid2You directly.");
    }

    let providerCustomerReference = sub.providerCustomerReference;
    if (!providerCustomerReference) {
      const customer = await this.provider.ensureCustomer({ organizationId: input.organizationId, billingEmail: input.billingEmail, legalName: input.legalName });
      providerCustomerReference = customer.providerCustomerReference;
      await this.subscriptions.setProviderReferences(sub.id, {
        providerCustomerReference,
        providerSubscriptionReference: sub.providerSubscriptionReference,
      });
    }

    return this.provider.createCheckoutSession({
      providerCustomerReference,
      planCode: plan.code,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });
  }

  async getBillingSummary(organizationId: string): Promise<BillingSummary> {
    const sub = await this.requireActiveSubscription(organizationId);
    const [paymentMethod, invoices] = await Promise.all([
      this.paymentMethods.findActiveForOrganization(organizationId),
      this.invoices.listForOrganization(organizationId),
    ]);
    return { subscription: sub, paymentMethod, invoices };
  }

  /** Requirement 22: "Pay Now" for a failed/past-due invoice, or an approved manual recovery. */
  async payInvoice(organizationId: string, invoiceId: string): Promise<SubscriptionInvoiceRecord> {
    const invoice = await this.invoices.findById(invoiceId);
    if (!invoice || invoice.organizationId !== organizationId) {
      throw new ValidationError("This invoice does not belong to this organization.");
    }
    if (!invoice.providerInvoiceReference) throw new ValidationError("This invoice has no provider reference to pay.");
    if (invoice.status === "paid") return invoice;

    const result = await this.provider.payInvoice(invoice.providerInvoiceReference);
    if (result.paid && result.paidAt) {
      await this.invoices.markPaid(invoice.id, { amountPaidMinorUnits: invoice.amountDueMinorUnits, paidAt: result.paidAt });
    } else {
      await this.invoices.markStatus(invoice.id, "past_due");
    }
    const updated = await this.invoices.findById(invoice.id);
    if (!updated) throw new ValidationError("Invoice disappeared during payment.");
    return updated;
  }

  /**
   * Requirement 26: upgrade applies immediately on the SAME subscription row (preserves provider
   * continuity — never cancel-and-recreate). Downgrade is requested at the provider as
   * "next_period"; this service does NOT yet swap the local `pricing_plan_id` for a deferred
   * downgrade — that requires a scheduled job/webhook reacting to the provider's own period
   * rollover, which does not exist in this phase (flagged here rather than silently pretending the
   * swap already happened — "do not silently create an impossible limit state").
   */
  async changePlan(organizationId: string, newPlanCode: string): Promise<SubscriptionRecord> {
    const sub = await this.requireActiveSubscription(organizationId);
    const currentPlan = await this.plans.findById(sub.pricingPlanId);
    const newPlan = await this.plans.findByCode(newPlanCode);
    if (!newPlan || !newPlan.isActive) throw new ValidationError("Unknown or inactive pricing plan.");
    if (newPlan.kind !== "business") throw new ValidationError("This plan is not available for a business organization.");
    if (!sub.providerSubscriptionReference) throw new ValidationError("This subscription has no active billing relationship to change.");

    const currentPrice = sub.negotiatedMonthlyFeeMinorUnits ?? currentPlan?.monthlyFeeMinorUnits ?? 0;
    const newPrice = newPlan.monthlyFeeMinorUnits ?? 0;
    const isUpgrade = newPrice >= currentPrice;

    await this.provider.changePlan({ providerSubscriptionReference: sub.providerSubscriptionReference, newPlanCode, effective: isUpgrade ? "immediate" : "next_period" });
    if (isUpgrade) {
      await this.subscriptions.setPricingPlan(sub.id, newPlan.id);
      await this.audit.record(
        platformBillingAuditPayload({
          actorUserId: null,
          actorRole: "business_staff",
          organizationId,
          action: PLATFORM_BILLING_AUDIT_ACTION.PLAN_UPGRADED,
          previousValue: { planCode: currentPlan?.code ?? null },
          newValue: { planCode: newPlan.code },
        }),
      );
    }
    const updated = await this.subscriptions.findById(sub.id);
    if (!updated) throw new ValidationError("Subscription disappeared during plan change.");
    return updated;
  }

  /** Requirement 24: cancellation defaults to end-of-period, never an immediate destructive cancel — local state change is always applied; the provider notification is best-effort. */
  /**
   * "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-6: the provider is called FIRST, and its
   * outcome GATES the local state change — the exact reverse of this method's prior
   * "mutate-local-then-best-effort-notify-provider" order, which could report "canceled" locally while
   * Stripe kept charging. When a real provider relationship exists (`providerSubscriptionReference` is
   * set) and the provider call fails, this method now throws `DependencyError` — local state is left
   * completely unchanged (no partial/inconsistent write), no CANCEL_AT_PERIOD_END audit is recorded,
   * and the caller/route surfaces a real failure (503) rather than a fabricated success. When NO
   * provider relationship exists yet (an organization that selected a tier but never completed hosted
   * checkout — nothing for Stripe to cancel), this remains a safe, honest LOCAL-only cancellation —
   * there is no provider state this could possibly misrepresent.
   */
  async cancelAtPeriodEnd(organizationId: string): Promise<SubscriptionRecord> {
    const sub = await this.requireActiveSubscription(organizationId);
    if (sub.providerSubscriptionReference) {
      try {
        await this.provider.cancelAtPeriodEnd(sub.providerSubscriptionReference);
      } catch {
        throw new DependencyError("Could not cancel this subscription with the billing provider. Your subscription was NOT changed — please try again shortly.");
      }
    }
    await this.subscriptions.requestCancelAtPeriodEnd(sub.id);
    await this.audit.record(
      platformBillingAuditPayload({
        actorUserId: null,
        actorRole: "business_staff",
        organizationId,
        action: PLATFORM_BILLING_AUDIT_ACTION.CANCEL_AT_PERIOD_END,
        newValue: { cancelAtPeriodEnd: true },
      }),
    );
    const updated = await this.subscriptions.findById(sub.id);
    if (!updated) throw new ValidationError("Subscription disappeared during cancellation.");
    return updated;
  }

  /**
   * "PAID2YOU — MASTER P0" (2026-10-03), Section 29: Change Payment Method via the provider's own
   * hosted experience (e.g. Stripe Billing Portal) — requires the organization to already have a
   * provider customer relationship (i.e. `setUpBilling` already ran once); never fabricates a
   * session for an organization with no subscription/no provider relationship at all.
   */
  async createPaymentMethodUpdateSession(organizationId: string, returnUrl: string): Promise<{ hostedUrl: string }> {
    const sub = await this.requireActiveSubscription(organizationId);
    if (!sub.providerCustomerReference) {
      throw new ValidationError("Set up billing before changing the payment method.");
    }
    return this.provider.createBillingPortalSession(sub.providerCustomerReference, returnUrl);
  }

  /** Requirement 25: reactivating a cancel-at-period-end subscription that has not yet lapsed. */
  /** "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-6: identical provider-first ordering/rationale to `cancelAtPeriodEnd` above — the provider's own outcome gates whether local state ever changes. */
  async reactivate(organizationId: string): Promise<SubscriptionRecord> {
    const sub = await this.requireActiveSubscription(organizationId);
    if (!sub.cancelAtPeriodEnd) throw new ConflictError("This subscription is not pending cancellation.");
    if (sub.providerSubscriptionReference) {
      try {
        await this.provider.reactivate(sub.providerSubscriptionReference);
      } catch {
        throw new DependencyError("Could not reactivate this subscription with the billing provider. Your subscription was NOT changed — please try again shortly.");
      }
    }
    await this.subscriptions.reactivate(sub.id);
    await this.audit.record(
      platformBillingAuditPayload({
        actorUserId: null,
        actorRole: "business_staff",
        organizationId,
        action: PLATFORM_BILLING_AUDIT_ACTION.REACTIVATED,
        newValue: { cancelAtPeriodEnd: false },
      }),
    );
    const updated = await this.subscriptions.findById(sub.id);
    if (!updated) throw new ValidationError("Subscription disappeared during reactivation.");
    return updated;
  }

  private async syncInvoices(organizationId: string, subscriptionId: string, providerSubscriptionReference: string): Promise<void> {
    const providerInvoices = await this.provider.listInvoices(providerSubscriptionReference);
    for (const inv of providerInvoices) {
      const existing = await this.invoices.findByProviderInvoiceReference(inv.providerInvoiceReference);
      if (existing) continue;
      await this.invoices.insert({
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
}
