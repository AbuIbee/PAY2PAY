import "server-only";
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { pricingPlan, pricingPlanEntitlement, subscription, subscriptionUsage, subscriptionUsageEvent } from "@/db/schema";
import { ArrangementUsageLimitExceededError, ConfigurationError } from "@/lib/errors";

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const NEW_ARRANGEMENTS_MONTHLY_METRIC_KEY = "new_arrangements_monthly";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02), Requirement 5/24, DB-10: the ONE call site that may
 * ever increment `new_arrangements_monthly` usage — invoked exclusively from
 * `DrizzleSigningApplicationRepository.applySigningAtomically`'s own transaction, at the exact
 * moment `bothSigned` becomes true (the agreement's transition INTO "signed", never "active" —
 * see that file's own doc comment on why "active" is a payment-triggered transition Requirement 5
 * explicitly excludes). Receives the SAME `tx` signing itself is using, so the usage check/increment
 * and the signature-completing writes are one atomic unit: if the organization is at its limit, this
 * throws, the entire transaction rolls back (no signature, no status change, no usage write), and
 * the caller sees a clear, actionable error — never a half-applied state.
 *
 * Personal agreements (`organizationId === null`) never reach this function — see the call site's
 * own guard — matching "Personal does not enforce a numeric limit" (Section 8/Requirement 2).
 *
 * Idempotent: the unique index on `subscription_usage_event(subscription_id, metric_key, source_id)`
 * means a retried call for an agreement that has already been counted hits a conflict here and is a
 * no-op (not a second increment) — see the ON CONFLICT handling below.
 *
 * Race-safe: `SELECT ... FOR UPDATE` on the `subscription_usage` row for this (subscription, metric,
 * period) is taken BEFORE the limit is checked, inside the caller's transaction — mirrors
 * `DrizzleSigningApplicationRepository`'s own established `agreement`/`agreement_version` lock-order
 * pattern. Two concurrent completing-signature transactions for the same organization therefore
 * serialize on this row: whichever commits first increments the count; the second re-reads the
 * now-current count and is correctly rejected if that pushed the organization to its limit.
 */
export async function recordQualifyingArrangementUsage(tx: DbTransaction, input: { organizationId: string; agreementId: string }): Promise<void> {
  const subscriptionRows = await tx
    .select()
    .from(subscription)
    .where(and(eq(subscription.profileKind, "business"), eq(subscription.profileId, input.organizationId), eq(subscription.status, "active")))
    .limit(1);
  const subscriptionRow = subscriptionRows[0];
  if (!subscriptionRow) {
    throw new ConfigurationError(
      `Organization ${input.organizationId} has no active subscription to meter arrangement usage against — it should not have been able to reach signing without one.`,
    );
  }

  const planRows = await tx.select().from(pricingPlan).where(eq(pricingPlan.id, subscriptionRow.pricingPlanId)).limit(1);
  const plan = planRows[0];
  if (!plan) throw new ConfigurationError(`Subscription ${subscriptionRow.id} references a pricing_plan that no longer exists.`);

  const entitlementRows = await tx
    .select()
    .from(pricingPlanEntitlement)
    .where(and(eq(pricingPlanEntitlement.pricingPlanId, plan.id), eq(pricingPlanEntitlement.featureKey, NEW_ARRANGEMENTS_MONTHLY_METRIC_KEY)))
    .limit(1);
  const entitlement = entitlementRows[0];
  // No entitlement row at all (should not happen for a canonical plan — see seedCanonicalBusinessPlans.ts)
  // is treated the same as "no cap", never as "zero" — mirrors pricing_plan_entitlement's own
  // documented "NULL = unlimited, never use 0 to mean unlimited" convention.
  //
  // Requirement 23/26: an organization-specific negotiated limit (Enterprise "2,000+ / custom")
  // always wins over the shared catalog entitlement when set — every Core/Growth/Scale subscription
  // leaves this NULL and is governed by the catalog limit exactly as before.
  const limitValue = subscriptionRow.negotiatedNewArrangementsMonthlyLimit ?? (entitlement ? entitlement.limitValue : null);

  const { periodStart, periodEnd } = resolveCurrentPeriod(subscriptionRow);

  const existingUsageRows = await tx
    .select()
    .from(subscriptionUsage)
    .where(
      and(
        eq(subscriptionUsage.subscriptionId, subscriptionRow.id),
        eq(subscriptionUsage.metricKey, NEW_ARRANGEMENTS_MONTHLY_METRIC_KEY),
        eq(subscriptionUsage.periodStart, periodStart),
      ),
    )
    .for("update")
    .limit(1);
  let usageRow = existingUsageRows[0];
  if (!usageRow) {
    const [inserted] = await tx
      .insert(subscriptionUsage)
      .values({
        organizationId: input.organizationId,
        subscriptionId: subscriptionRow.id,
        metricKey: NEW_ARRANGEMENTS_MONTHLY_METRIC_KEY,
        periodStart,
        periodEnd,
        count: 0,
      })
      .onConflictDoNothing({ target: [subscriptionUsage.subscriptionId, subscriptionUsage.metricKey, subscriptionUsage.periodStart] })
      .returning();
    if (inserted) {
      usageRow = inserted;
    } else {
      // Lost the insert race to a concurrent transaction — re-select and lock the row it created.
      const rows = await tx
        .select()
        .from(subscriptionUsage)
        .where(
          and(
            eq(subscriptionUsage.subscriptionId, subscriptionRow.id),
            eq(subscriptionUsage.metricKey, NEW_ARRANGEMENTS_MONTHLY_METRIC_KEY),
            eq(subscriptionUsage.periodStart, periodStart),
          ),
        )
        .for("update")
        .limit(1);
      usageRow = rows[0];
    }
  }
  if (!usageRow) throw new ConfigurationError("subscription_usage row could not be created or located during metering.");

  if (limitValue !== null && usageRow.count >= limitValue) {
    throw new ArrangementUsageLimitExceededError({ planCode: plan.code, limit: limitValue, periodEnd });
  }

  const [eventRow] = await tx
    .insert(subscriptionUsageEvent)
    .values({
      organizationId: input.organizationId,
      subscriptionId: subscriptionRow.id,
      metricKey: NEW_ARRANGEMENTS_MONTHLY_METRIC_KEY,
      sourceType: "agreement",
      sourceId: input.agreementId,
    })
    .onConflictDoNothing({ target: [subscriptionUsageEvent.subscriptionId, subscriptionUsageEvent.metricKey, subscriptionUsageEvent.sourceId] })
    .returning();
  // Already recorded for this exact agreement (a retried signing-completion call) — no-op, never a
  // second increment. This is the idempotency guarantee Requirement 5/DB-10 require.
  if (!eventRow) return;

  await tx.update(subscriptionUsage).set({ count: usageRow.count + 1, updatedAt: new Date() }).where(eq(subscriptionUsage.id, usageRow.id));
}

/**
 * Prefers the subscription's own billing-cycle columns (set once `PlatformBillingService` actually
 * starts a subscription against a real/fake provider — see platformBillingProvider.ts) and falls
 * back to the current UTC calendar month when they are unset, so metering is correct from day one
 * even before a billing cycle has been established for an organization.
 *
 * Exported so any READ path that needs to show "this billing period's usage" (the Billing &
 * Subscription page, Section 10/13) resolves the identical period this WRITE path counts against —
 * never a second, independently-computed period boundary that could silently disagree with it.
 */
export function resolveCurrentPeriod(subscriptionRow: { currentPeriodStart: Date | null; currentPeriodEnd: Date | null }): { periodStart: Date; periodEnd: Date } {
  if (subscriptionRow.currentPeriodStart && subscriptionRow.currentPeriodEnd) {
    return { periodStart: subscriptionRow.currentPeriodStart, periodEnd: subscriptionRow.currentPeriodEnd };
  }
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart, periodEnd };
}
