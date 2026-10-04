-- PAID2YOU PLATFORM EXPANSION (2026-10-02), backend-foundations phase. Fixes a real gap found by
-- running the full disposable-Postgres suite: the earlier 20261002000000_b2b_organization_foundation.sql
-- migration was hand-ported from a different branch (see its own header) and captured only PART of
-- this branch's actual schema diff — pricing_plan_entitlement/business_customer/business_obligation,
-- the organization_role enum conversion, business_profile.slug/updated_at, business_staff_member.
-- updated_at, subscription.current_period_start/end, and agreement.organization_id. It never created
-- organization_role/organization_role_permission, any of platformExpansion.ts's tables, the role_id
-- columns, audit_event.actor_membership_id, or subscription's remaining cancellation/provider-reference
-- columns — all of which src/db/schema/ already declares and multiple services already read/write.
-- `npx drizzle-kit generate` against the current schema confirms exactly this remaining delta (it
-- re-proposed the already-applied statements too, since its own snapshot history never recorded
-- 20261002000000 — this migration includes only the genuinely missing statements from that output,
-- in FK-safe dependency order).
--
-- Preserves current data: every new table is a CREATE TABLE (nothing to lose); every ALTER TABLE
-- below adds a nullable or safely-defaulted column to an existing table, never drops/narrows one.
--
-- NAMING COLLISION FIX (found by running the full disposable-Postgres suite against this very
-- migration): `organization_role` was already claimed as a Postgres TYPE name by the legacy
-- business_staff_member/business_staff_invitation role enum (20260811130400_sprint4_business_staff_
-- permissions.sql) — `CREATE TABLE "organization_role"` below would otherwise collide with it (a
-- table implicitly creates a same-named row type). Renaming the enum type is lossless: Postgres
-- resolves a column's type by OID, never by name, so every existing `role` value in both tables is
-- completely unaffected. See src/db/schema/enums.ts's own doc comment on organizationRoleEnum.
ALTER TYPE "public"."organization_role" RENAME TO "legacy_staff_role";--> statement-breakpoint
CREATE TYPE "public"."organization_role_permission_scope" AS ENUM('organization', 'assigned', 'own', 'team', 'none');--> statement-breakpoint
CREATE TYPE "public"."business_reference_type" AS ENUM('LOAD', 'SHIPMENT', 'INVOICE', 'PURCHASE_ORDER', 'ORDER', 'DELIVERY', 'SERVICE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."business_verification_status" AS ENUM('not_submitted', 'pending', 'verified', 'rejected', 'review_required');--> statement-breakpoint
CREATE TYPE "public"."organization_document_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."organization_document_type" AS ENUM('INVOICE', 'BILL_OF_LADING', 'PROOF_OF_DELIVERY', 'RATE_CONFIRMATION', 'PURCHASE_ORDER', 'STATEMENT', 'CONTRACT', 'SUPPORTING_DOCUMENT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."subscription_invoice_status" AS ENUM('open', 'paid', 'past_due', 'void');--> statement-breakpoint
CREATE TYPE "public"."subscription_payment_method_status" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."subscription_payment_method_type" AS ENUM('card', 'bank_account', 'other');--> statement-breakpoint
CREATE TABLE "organization_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"is_owner_role" boolean DEFAULT false NOT NULL,
	"is_protected" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_role" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_role_permission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"scope" "organization_role_permission_scope" DEFAULT 'organization' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_role_permission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "business_reference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reference_type" "business_reference_type" NOT NULL,
	"external_reference" text,
	"source_system" text,
	"reference_date" date,
	"counterparty_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_reference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "business_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"status" "business_verification_status" DEFAULT 'not_submitted' NOT NULL,
	"submitted_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"legal_name_result" text,
	"tax_id_result" text,
	"address_result" text,
	"representative_result" text,
	"failure_code" text,
	"review_required" boolean DEFAULT false NOT NULL,
	"tax_id_last4" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "legal_acceptance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"document_type" text NOT NULL,
	"document_version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "legal_acceptance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_type" "organization_document_type" NOT NULL,
	"file_name" text NOT NULL,
	"storage_path" text NOT NULL,
	"mime_type" text,
	"size_bytes" integer,
	"uploaded_by_user_id" uuid NOT NULL,
	"related_agreement_id" uuid,
	"related_customer_id" uuid,
	"status" "organization_document_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount_due_minor_units" integer NOT NULL,
	"amount_paid_minor_units" integer DEFAULT 0 NOT NULL,
	"status" "subscription_invoice_status" DEFAULT 'open' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"provider_invoice_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_invoice_amount_due_nonnegative" CHECK ("subscription_invoice"."amount_due_minor_units" >= 0)
);
--> statement-breakpoint
ALTER TABLE "subscription_invoice" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_payment_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_customer_reference" text NOT NULL,
	"provider_payment_method_reference" text NOT NULL,
	"payment_type" "subscription_payment_method_type" NOT NULL,
	"display_last4" text,
	"display_name" text,
	"status" "subscription_payment_method_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_payment_method" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_usage_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_usage_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "business_staff_member" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "business_staff_invitation" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_event" ADD COLUMN "actor_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "provider_customer_reference" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "provider_subscription_reference" text;--> statement-breakpoint
ALTER TABLE "organization_role" ADD CONSTRAINT "organization_role_organization_id_business_profile_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_role_permission" ADD CONSTRAINT "organization_role_permission_role_id_organization_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."organization_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reference" ADD CONSTRAINT "business_reference_organization_id_business_profile_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reference" ADD CONSTRAINT "business_reference_counterparty_id_business_customer_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."business_customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_verification" ADD CONSTRAINT "business_verification_organization_id_business_profile_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptance" ADD CONSTRAINT "legal_acceptance_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptance" ADD CONSTRAINT "legal_acceptance_organization_id_business_profile_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_document" ADD CONSTRAINT "organization_document_organization_id_business_profile_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_document" ADD CONSTRAINT "organization_document_uploaded_by_user_id_user_account_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_document" ADD CONSTRAINT "organization_document_related_agreement_id_agreement_id_fk" FOREIGN KEY ("related_agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_document" ADD CONSTRAINT "organization_document_related_customer_id_business_customer_id_fk" FOREIGN KEY ("related_customer_id") REFERENCES "public"."business_customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_organization_id_business_profile_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payment_method" ADD CONSTRAINT "subscription_payment_method_organization_id_business_profile_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_usage" ADD CONSTRAINT "subscription_usage_organization_id_business_profile_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_usage" ADD CONSTRAINT "subscription_usage_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_usage_event" ADD CONSTRAINT "subscription_usage_event_organization_id_business_profile_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_usage_event" ADD CONSTRAINT "subscription_usage_event_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_staff_member" ADD CONSTRAINT "business_staff_member_role_id_organization_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."organization_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_staff_invitation" ADD CONSTRAINT "business_staff_invitation_role_id_organization_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."organization_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_role_org_name_unique" ON "organization_role" USING btree ("organization_id","display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_role_org_owner_unique" ON "organization_role" USING btree ("organization_id") WHERE "organization_role"."is_owner_role" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_role_permission_role_key_unique" ON "organization_role_permission" USING btree ("role_id","permission_key");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_usage_subscription_metric_period_unique" ON "subscription_usage" USING btree ("subscription_id","metric_key","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_usage_event_subscription_metric_source_unique" ON "subscription_usage_event" USING btree ("subscription_id","metric_key","source_id");
