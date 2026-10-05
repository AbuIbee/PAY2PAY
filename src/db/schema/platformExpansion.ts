import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agreement } from "./agreement";
import { businessCustomer, businessObligation } from "./businessReceivables";
import { businessProfile, userAccount } from "./identity";
import { subscription } from "./pricing";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02): the platform's OWN billing domain (Requirements
 * 19-29, DB-7/DB-8/DB-10) — entirely separate from customer agreements/payments (Requirement 21/39).
 * `subscription` (src/db/schema/pricing.ts) already models "an organization has an active plan";
 * these tables model what that subscription actually BILLS and COSTS, never mixed with the
 * customer-facing `agreement`/`payment_attempt` tables.
 */

export const subscriptionInvoiceStatusEnum = pgEnum("subscription_invoice_status", ["open", "paid", "past_due", "void"]);

export const subscriptionInvoice = pgTable(
  "subscription_invoice",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => businessProfile.id),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscription.id),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    amountDueMinorUnits: integer("amount_due_minor_units").notNull(),
    amountPaidMinorUnits: integer("amount_paid_minor_units").notNull().default(0),
    status: subscriptionInvoiceStatusEnum("status").notNull().default("open"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // Opaque reference into PlatformBillingProvider's own system — never a secret.
    providerInvoiceReference: text("provider_invoice_reference"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("subscription_invoice_amount_due_nonnegative", sql`${table.amountDueMinorUnits} >= 0`)],
).enableRLS();

export const subscriptionPaymentMethodTypeEnum = pgEnum("subscription_payment_method_type", ["card", "bank_account", "other"]);
export const subscriptionPaymentMethodStatusEnum = pgEnum("subscription_payment_method_status", ["active", "removed"]);

/**
 * DB-8: SAFE METADATA ONLY — never CVV, card PAN, online-banking password, or full raw bank
 * credentials (Requirement 10's own guardrail, repeated here because this is the one table most
 * tempting to misuse). `providerPaymentMethodReference` is the only thing capable of actually
 * charging anything, and it is opaque to this application — meaningless without the real
 * PlatformBillingProvider's own credentials, which never live in this table or any application table.
 */
export const subscriptionPaymentMethod = pgTable("subscription_payment_method", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => businessProfile.id),
  provider: text("provider").notNull(),
  providerCustomerReference: text("provider_customer_reference").notNull(),
  providerPaymentMethodReference: text("provider_payment_method_reference").notNull(),
  paymentType: subscriptionPaymentMethodTypeEnum("payment_type").notNull(),
  displayLast4: text("display_last4"),
  displayName: text("display_name"),
  status: subscriptionPaymentMethodStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * DB-10: the per-period counter a plan limit (e.g. Core's 25 new_arrangements_monthly) actually
 * checks against. Never written to directly by a "count this" call site — see
 * subscriptionUsageEvent below, which is the ONLY insert path, with the counter increment riding
 * inside the same transaction as that event's own idempotent insert.
 */
export const subscriptionUsage = pgTable(
  "subscription_usage",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => businessProfile.id),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscription.id),
    metricKey: text("metric_key").notNull(), // e.g. 'new_arrangements_monthly'
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("subscription_usage_subscription_metric_period_unique").on(table.subscriptionId, table.metricKey, table.periodStart)],
).enableRLS();

/**
 * DB-10's own idempotency key: Requirement 5 — exactly one arrangement activation (the agreement's
 * own transition INTO "signed", its first fully-executed state — never "active," which is a
 * payment-triggered transition Requirement 5 explicitly excludes from counting) may ever increment
 * usage for a given (subscription, metric, source). A retried/duplicate attempt to record the SAME
 * agreement's activation hits this table's own unique constraint and is a no-op — the counter above
 * is only ever incremented alongside a row that was genuinely newly inserted here, in the same
 * transaction. This table is NOT wired to the real signing code path yet (see
 * docs/PROGRESS.md-equivalent note in this phase's own report) — schema and the idempotency
 * contract are established now; the actual increment call site is a deliberately separate, later
 * integration step into agreementService.ts's signing transition.
 */
export const subscriptionUsageEvent = pgTable(
  "subscription_usage_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => businessProfile.id),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscription.id),
    metricKey: text("metric_key").notNull(),
    sourceType: text("source_type").notNull(), // e.g. 'agreement'
    sourceId: uuid("source_id").notNull(), // e.g. agreement.id
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("subscription_usage_event_subscription_metric_source_unique").on(table.subscriptionId, table.metricKey, table.sourceId)],
).enableRLS();

export const businessVerificationStatusEnum = pgEnum("business_verification_status", [
  "not_submitted",
  "pending",
  "verified",
  "rejected",
  "review_required",
]);

/**
 * DB-12/Section 9: the raw Tax ID/EIN is NEVER a column here or anywhere in this application's
 * tables — only `taxIdLast4` (display-safe) and the verification PROVIDER's own opaque reference/
 * result codes. The actual number, when collected, is passed server-side directly to a real
 * BusinessVerificationProvider (src/lib/organizations/businessVerificationProvider.ts) and never
 * persisted in application-readable form. `status` starts, and stays, "not_submitted"/"pending"
 * until that real provider reports a result — production never auto-verifies (see that file's own
 * NOT_CONFIGURED contract).
 */
export const businessVerification = pgTable("business_verification", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => businessProfile.id),
  provider: text("provider").notNull(),
  providerReference: text("provider_reference"),
  status: businessVerificationStatusEnum("status").notNull().default("not_submitted"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  legalNameResult: text("legal_name_result"),
  taxIdResult: text("tax_id_result"),
  addressResult: text("address_result"),
  representativeResult: text("representative_result"),
  failureCode: text("failure_code"),
  reviewRequired: boolean("review_required").notNull().default(false),
  taxIdLast4: text("tax_id_last4"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

/**
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 14/25: Middesk's own async verification-result
 * delivery mechanism, mirroring `kycWebhookEvent` (src/db/schema/kyc.ts) exactly — a dedicated
 * dedupe/replay-protection table per external integration, never shared across unrelated providers.
 * `payload` never contains the raw EIN/Tax ID (Middesk's own webhook events never include it; this
 * application also never requests/stores it anywhere — see businessVerificationService.ts).
 */
export const businessVerificationWebhookEvent = pgTable(
  "business_verification_webhook_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    signatureVerified: boolean("signature_verified").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /**
     * "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-3: when this row was last atomically
     * claimed for processing (`DrizzleBusinessVerificationWebhookEventRepository.claimEvent`'s own
     * `INSERT ... ON CONFLICT DO UPDATE ... WHERE` upsert) — NULL only ever means "never claimed."
     * Lets a later delivery of the SAME (provider, provider_event_id) safely retry a row whose first
     * attempt failed (processed_at still NULL) instead of being permanently treated as a duplicate,
     * while a stale-claim window still prevents two genuinely concurrent deliveries from both
     * processing it at once. See that repository's own doc comment for the exact mechanism.
     */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("business_verification_webhook_event_provider_event_unique").on(table.provider, table.providerEventId)],
).enableRLS();

/**
 * "PAID2YOU — MASTER P0" (2026-10-03), Section 24/25: Stripe Billing's own webhook delivery,
 * mirroring `kycWebhookEvent`/`businessVerificationWebhookEvent` exactly. `payload` is the Stripe
 * event's own `data.object` — never a raw card number/CVC (Stripe's own API never returns either;
 * see stripePlatformBillingProvider.ts's own doc comment).
 */
export const platformBillingWebhookEvent = pgTable(
  "platform_billing_webhook_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    signatureVerified: boolean("signature_verified").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /** P0-3: identical mechanism/rationale to `businessVerificationWebhookEvent.claimedAt` above. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("platform_billing_webhook_event_provider_event_unique").on(table.provider, table.providerEventId)],
).enableRLS();

export const businessReferenceTypeEnum = pgEnum("business_reference_type", [
  "LOAD",
  "SHIPMENT",
  "INVOICE",
  "PURCHASE_ORDER",
  "ORDER",
  "DELIVERY",
  "SERVICE",
  "OTHER",
]);

/**
 * Requirement 17/DB-13: a neutral operational-reference layer balances/agreements/documents may
 * point at, WITHOUT replacing business_customer (Requirement 18) or any existing counterparty
 * model — `counterpartyId` is a nullable, bare (non-FK-constrained) pointer to a business_customer
 * row, mirroring this schema's own established polymorphic-reference convention elsewhere (never a
 * hard requirement — many references, e.g. a standalone LOAD number, have no customer yet).
 */
export const businessReference = pgTable("business_reference", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => businessProfile.id),
  referenceType: businessReferenceTypeEnum("reference_type").notNull(),
  externalReference: text("external_reference"),
  sourceSystem: text("source_system"),
  referenceDate: date("reference_date"),
  counterpartyId: uuid("counterparty_id").references(() => businessCustomer.id),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const organizationDocumentTypeEnum = pgEnum("organization_document_type", [
  "INVOICE",
  "BILL_OF_LADING",
  "PROOF_OF_DELIVERY",
  "RATE_CONFIRMATION",
  "PURCHASE_ORDER",
  "STATEMENT",
  "CONTRACT",
  "SUPPORTING_DOCUMENT",
  "OTHER",
]);
export const organizationDocumentStatusEnum = pgEnum("organization_document_status", ["active", "archived"]);

/**
 * DB-14: Postgres holds METADATA only — `storagePath` is a safe, organization-scoped Supabase
 * Storage object path (never a raw binary, never a signed URL persisted at rest); the binary itself
 * lives in Supabase Storage, accessed only through the server-mediated pattern this codebase already
 * established for agreement evidence/signed PDFs (SupabaseDocumentStorage), never a direct
 * client-supplied path.
 *
 * "PAID2YOU — SECURE BUSINESS ATTACHMENTS ITERATION" (2026-10-05): this table was prepared in a prior
 * phase (DB-14) but never wired to any repository/service/route until now — the architecture audit
 * for this iteration found it was the correct, already-matching shape (organization-scoped,
 * `document_type` already the exact required vocabulary, already linked to `agreement`/
 * `business_customer`) and reused it rather than creating a second, competing document/attachment
 * table. `relatedObligationId` is the one genuinely new column this iteration adds — the existing
 * table had no link to Business Obligation ("Outstanding Balance"), the third required attachment
 * parent. `relatedAgreementId`/`relatedCustomerId`/`relatedObligationId` are mutually exclusive (a
 * document's "parent resource," singular, per this iteration's own requirement) — enforced by the
 * `organization_document_single_related_parent` CHECK below, never left to application code alone.
 */
export const organizationDocument = pgTable(
  "organization_document",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => businessProfile.id),
    documentType: organizationDocumentTypeEnum("document_type").notNull(),
    fileName: text("file_name").notNull(),
    storagePath: text("storage_path").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => userAccount.id),
    relatedAgreementId: uuid("related_agreement_id").references(() => agreement.id),
    relatedCustomerId: uuid("related_customer_id").references(() => businessCustomer.id),
    /** "SECURE BUSINESS ATTACHMENTS ITERATION" (2026-10-05): new, nullable, additive — Outstanding Balance attachments. */
    relatedObligationId: uuid("related_obligation_id").references(() => businessObligation.id),
    status: organizationDocumentStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "organization_document_single_related_parent",
      sql`(case when ${table.relatedAgreementId} is null then 0 else 1 end + case when ${table.relatedCustomerId} is null then 0 else 1 end + case when ${table.relatedObligationId} is null then 0 else 1 end) <= 1`,
    ),
    index("organization_document_organization_id_idx").on(table.organizationId),
    index("organization_document_related_agreement_id_idx").on(table.relatedAgreementId),
    index("organization_document_related_customer_id_idx").on(table.relatedCustomerId),
    index("organization_document_related_obligation_id_idx").on(table.relatedObligationId),
  ],
).enableRLS();

/**
 * DB-16: acceptance of a VERSIONED legal document — Terms/Privacy/Business Subscription Policy/
 * recurring-payment-authorization alike, distinguished by `documentType` + `documentVersion`, never
 * a boolean flag that can't say WHICH version was accepted. `organizationId` is nullable — a
 * Personal-only acceptance (e.g. Terms at personal signup) has none; a Business Subscription Policy
 * acceptance always does.
 */
export const legalAcceptance = pgTable("legal_acceptance", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => userAccount.id),
  organizationId: uuid("organization_id").references(() => businessProfile.id),
  documentType: text("document_type").notNull(), // e.g. 'terms' | 'privacy' | 'business_subscription_policy' | 'recurring_payment_authorization'
  documentVersion: text("document_version").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata"),
}).enableRLS();
