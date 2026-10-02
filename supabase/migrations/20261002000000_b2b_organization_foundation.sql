-- PAID2YOU — B2B IDENTITY / ORGANIZATION / SUBSCRIPTION ARCHITECTURE, Phase 2 (2026-10-02).
-- Adapts existing tables (business_profile = Organization, business_staff_member = Organization
-- Membership) rather than introducing parallel organization tables. See the schema files'
-- own doc comments (src/db/schema/identity.ts, enums.ts, pricing.ts, businessReceivables.ts,
-- agreement.ts) for the full architectural rationale.
--
-- Ported from the original B2B implementation (architecture/bank-managed-payments-v3 base,
-- commit d6c4476), regenerated fresh against this branch's own migration lineage
-- (architecture/b2b-organization-workspaces-v2, based on remediation/08-authorization-tenant-
-- isolation @ 5dc98b3) rather than copied — the two branches' migration histories diverged after a
-- shared ancestor (this branch has the Adyen phase1b/1c/2/2a + phase3a_payout_attempt migrations;
-- the original branch had smsConsent + differently-named payout/ledger-parity migrations in their
-- place). The resulting schema delta is identical to the original migration regardless, since the
-- B2B changes never touch any of the diverged tables.
--
-- ROLE CONVERSION SAFETY: the business_staff_member.role / business_staff_invitation.role
-- conversions below (free text -> the closed organization_role enum) were approved on the explicit
-- condition that zero rows exist in either table — verified by a direct read-only query against the
-- live target database before this migration was authored. This migration does not define, and must
-- never silently invent, a mapping from the old free-text vocabulary (owner | manager |
-- receivables_staff | accountant_viewer | custom) to the new enum. The guards immediately below fail
-- the entire migration closed if that assumption no longer holds at deploy time, rather than letting
-- the ALTER COLUMN ... USING cast either succeed by accident or throw a raw, unexplained cast error.
DO $$
DECLARE
  existing_count integer;
BEGIN
  SELECT count(*) INTO existing_count FROM "business_staff_member";
  IF existing_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: business_staff_member contains % existing row(s). The organization_role enum conversion assumes zero existing rows and defines no legacy-role mapping (owner | manager | receivables_staff | accountant_viewer | custom). Resolve this manually — with an explicit, owner-approved mapping — before re-running this migration.', existing_count;
  END IF;
END $$;--> statement-breakpoint
DO $$
DECLARE
  existing_count integer;
BEGIN
  SELECT count(*) INTO existing_count FROM "business_staff_invitation";
  IF existing_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: business_staff_invitation contains % existing row(s). The organization_role enum conversion assumes zero existing rows and defines no legacy-role mapping (owner | manager | receivables_staff | accountant_viewer | custom). Resolve this manually — with an explicit, owner-approved mapping — before re-running this migration.', existing_count;
  END IF;
END $$;--> statement-breakpoint
CREATE TYPE "public"."organization_role" AS ENUM('OWNER', 'FINANCE_ADMIN', 'AR_MANAGER', 'AR_AGENT', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."business_customer_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."business_obligation_status" AS ENUM('open', 'paid', 'written_off');--> statement-breakpoint
CREATE TABLE "pricing_plan_entitlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pricing_plan_id" uuid NOT NULL,
	"feature_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"limit_value" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pricing_plan_entitlement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "business_customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_profile_id" uuid NOT NULL,
	"counterparty_profile_kind" "profile_kind" NOT NULL,
	"counterparty_profile_id" uuid NOT NULL,
	"external_customer_reference" text,
	"status" "business_customer_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_customer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "business_obligation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_profile_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"agreement_id" uuid,
	"external_reference" text,
	"invoice_reference" text,
	"original_amount_minor_units" integer NOT NULL,
	"agreed_amount_minor_units" integer NOT NULL,
	"status" "business_obligation_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_obligation_original_amount_positive" CHECK ("business_obligation"."original_amount_minor_units" > 0),
	CONSTRAINT "business_obligation_agreed_amount_positive" CHECK ("business_obligation"."agreed_amount_minor_units" > 0)
);
--> statement-breakpoint
ALTER TABLE "business_obligation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "business_staff_member" ALTER COLUMN "role" SET DATA TYPE "public"."organization_role" USING "role"::"public"."organization_role";--> statement-breakpoint
ALTER TABLE "business_staff_invitation" ALTER COLUMN "role" SET DATA TYPE "public"."organization_role" USING "role"::"public"."organization_role";--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "business_profile" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "business_staff_member" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "current_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agreement" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "pricing_plan_entitlement" ADD CONSTRAINT "pricing_plan_entitlement_pricing_plan_id_pricing_plan_id_fk" FOREIGN KEY ("pricing_plan_id") REFERENCES "public"."pricing_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_customer" ADD CONSTRAINT "business_customer_business_profile_id_business_profile_id_fk" FOREIGN KEY ("business_profile_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_obligation" ADD CONSTRAINT "business_obligation_business_profile_id_business_profile_id_fk" FOREIGN KEY ("business_profile_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_obligation" ADD CONSTRAINT "business_obligation_customer_id_business_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."business_customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_obligation" ADD CONSTRAINT "business_obligation_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_plan_entitlement_plan_feature_unique" ON "pricing_plan_entitlement" USING btree ("pricing_plan_id","feature_key");--> statement-breakpoint
CREATE UNIQUE INDEX "business_customer_org_counterparty_unique" ON "business_customer" USING btree ("business_profile_id","counterparty_profile_kind","counterparty_profile_id");--> statement-breakpoint
CREATE INDEX "business_obligation_business_profile_id_idx" ON "business_obligation" USING btree ("business_profile_id");--> statement-breakpoint
CREATE INDEX "business_obligation_customer_id_idx" ON "business_obligation" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "agreement" ADD CONSTRAINT "agreement_organization_id_business_profile_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_profile_slug_unique" ON "business_profile" USING btree ("slug") WHERE "business_profile"."slug" IS NOT NULL;
