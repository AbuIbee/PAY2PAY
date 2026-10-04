import "server-only";
import { getServerEnv } from "@/config/env";
import { ConfigurationError } from "@/lib/errors";
import { assertProviderAvailableForRuntime } from "@/lib/providers/providerCapabilities";
import { StripePlatformBillingProvider } from "./stripePlatformBillingProvider";
import type {
  AttachPaymentMethodInput,
  AttachPaymentMethodResult,
  ChangePlanInput,
  ChangePlanResult,
  CreateCheckoutSessionInput,
  CreateCheckoutSessionResult,
  EnsureCustomerInput,
  EnsureCustomerResult,
  ParsedPlatformBillingWebhookEvent,
  PayInvoiceResult,
  PlatformBillingProvider,
  ProviderInvoice,
  RetrieveSubscriptionStateResult,
  StartSubscriptionInput,
  StartSubscriptionResult,
} from "./platformBillingProvider";

let cached: PlatformBillingProvider | null = null;

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Section 10, wired to a real adapter by "PAID2YOU —
 * MASTER P0" (2026-10-03), Section 19: mirrors getPaymentProvider.ts's identical
 * descriptor-check-then-construct shape. `stripe` is now a registered descriptor — when
 * PLATFORM_BILLING_PROVIDER=stripe and STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET are both configured,
 * this constructs a real StripePlatformBillingProvider (the per-plan STRIPE_*_PRICE_ID variables are
 * read lazily inside the adapter itself, each enforced only when that specific plan is actually
 * started/changed to — never required all-at-once here). Any other (unregistered) provider name
 * still throws ProviderNotAvailableError before reaching here — every PlatformBillingService
 * operation that genuinely requires a live provider propagates that directly, never fabricates a
 * successful charge (Section 10/22's own "never report payment succeeded without provider
 * confirmation").
 */
export function getPlatformBillingProvider(): PlatformBillingProvider {
  if (!cached) {
    const env = getServerEnv();
    const descriptor = assertProviderAvailableForRuntime("platform_billing", env.PLATFORM_BILLING_PROVIDER, env.APP_ENV);
    if (descriptor.providerName === "stripe") {
      const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_STARTER_PRICE_ID, STRIPE_CORE_PRICE_ID, STRIPE_GROWTH_PRICE_ID, STRIPE_SCALE_PRICE_ID } = env;
      if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
        throw new ConfigurationError("PLATFORM_BILLING_PROVIDER=stripe requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET to both be configured.");
      }
      cached = new StripePlatformBillingProvider({
        secretKey: STRIPE_SECRET_KEY,
        webhookSecret: STRIPE_WEBHOOK_SECRET,
        priceIdByPlanCode: {
          paid2you_business_starter: STRIPE_STARTER_PRICE_ID,
          paid2you_business_core: STRIPE_CORE_PRICE_ID,
          paid2you_business_growth: STRIPE_GROWTH_PRICE_ID,
          paid2you_business_scale: STRIPE_SCALE_PRICE_ID,
          // Deliberately no paid2you_business_enterprise entry — Section 21's own "reject an attempt
          // to self-enroll Enterprise through the normal standard-plan route": requirePriceId throws
          // for it exactly like any other unconfigured plan, and the route layer
          // (src/app/api/organizations/billing/change-plan/route.ts) already rejects Enterprise
          // before this adapter would ever be reached for it anyway.
        },
      });
      return cached;
    }
    throw new ConfigurationError(`No platform billing provider factory is registered for "${descriptor.providerName}".`);
  }
  return cached;
}

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 11/12: the Billing & Subscription
 * page's own non-throwing check — mirrors `getBankConnectionServiceIfAvailable`'s identical
 * try/construct/catch-null pattern. Lets a read-only page render an honest "billing isn't configured
 * yet" state instead of needing to catch `ProviderNotAvailableError` itself.
 */
export function isPlatformBillingProviderConfigured(): boolean {
  try {
    getPlatformBillingProvider();
    return true;
  } catch {
    return false;
  }
}

/**
 * "PAID2YOU PRODUCTION LAUNCH" (2026-10-03), Phase 2, Section 10/16: defers `getPlatformBillingProvider()`
 * resolution to the moment a method is actually CALLED, never at construction. `PlatformBillingService`
 * itself already documents "cancellation/reactivation are local-first... do not condition 'can cancel'
 * on a live provider existing" and wraps its own `cancelAtPeriodEnd`/`reactivate` provider calls in a
 * try/catch that discards the error — but `getPlatformBillingService()`'s EAGER `getPlatformBillingProvider()`
 * call previously made constructing the whole service throw before those methods could ever run,
 * silently contradicting that stated design. This wrapper fixes exactly that: every method still fails
 * exactly the same way (`ProviderNotAvailableError`/`ConfigurationError`, now raised at first use
 * instead of at construction) for the provider-REQUIRING operations (setUpBilling/payInvoice/
 * changePlan), while finally letting the provider-INDEPENDENT ones (cancel/reactivate) actually reach
 * their own local-first behavior.
 */
class LazyPlatformBillingProvider implements PlatformBillingProvider {
  get providerName(): string {
    return getPlatformBillingProvider().providerName;
  }
  get providerEnvironment(): "production" {
    return getPlatformBillingProvider().providerEnvironment;
  }
  async ensureCustomer(input: EnsureCustomerInput): Promise<EnsureCustomerResult> {
    return getPlatformBillingProvider().ensureCustomer(input);
  }
  async attachPaymentMethod(input: AttachPaymentMethodInput): Promise<AttachPaymentMethodResult> {
    return getPlatformBillingProvider().attachPaymentMethod(input);
  }
  async startSubscription(input: StartSubscriptionInput): Promise<StartSubscriptionResult> {
    return getPlatformBillingProvider().startSubscription(input);
  }
  async retrieveSubscriptionState(providerSubscriptionReference: string): Promise<RetrieveSubscriptionStateResult> {
    return getPlatformBillingProvider().retrieveSubscriptionState(providerSubscriptionReference);
  }
  async payInvoice(providerInvoiceReference: string): Promise<PayInvoiceResult> {
    return getPlatformBillingProvider().payInvoice(providerInvoiceReference);
  }
  async changePlan(input: ChangePlanInput): Promise<ChangePlanResult> {
    return getPlatformBillingProvider().changePlan(input);
  }
  async cancelAtPeriodEnd(providerSubscriptionReference: string): Promise<void> {
    return getPlatformBillingProvider().cancelAtPeriodEnd(providerSubscriptionReference);
  }
  async reactivate(providerSubscriptionReference: string): Promise<void> {
    return getPlatformBillingProvider().reactivate(providerSubscriptionReference);
  }
  async listInvoices(providerSubscriptionReference: string): Promise<ProviderInvoice[]> {
    return getPlatformBillingProvider().listInvoices(providerSubscriptionReference);
  }
  async createBillingPortalSession(providerCustomerReference: string, returnUrl: string): Promise<{ hostedUrl: string }> {
    return getPlatformBillingProvider().createBillingPortalSession(providerCustomerReference, returnUrl);
  }
  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CreateCheckoutSessionResult> {
    return getPlatformBillingProvider().createCheckoutSession(input);
  }
  async retrieveSubscriptionPaymentMethod(providerSubscriptionReference: string): Promise<AttachPaymentMethodResult> {
    return getPlatformBillingProvider().retrieveSubscriptionPaymentMethod(providerSubscriptionReference);
  }
  verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    return getPlatformBillingProvider().verifyWebhookSignature(rawBody, signatureHeader);
  }
  parseWebhookEvent(rawBody: string): ParsedPlatformBillingWebhookEvent {
    return getPlatformBillingProvider().parseWebhookEvent(rawBody);
  }
}

let lazyProvider: PlatformBillingProvider | null = null;

/** The one instance `getPlatformBillingService()` should inject — see `LazyPlatformBillingProvider`'s own doc comment. */
export function getLazyPlatformBillingProvider(): PlatformBillingProvider {
  if (!lazyProvider) lazyProvider = new LazyPlatformBillingProvider();
  return lazyProvider;
}
