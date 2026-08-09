CREATE TYPE "public"."early_access_account_type" AS ENUM('individual', 'business');--> statement-breakpoint
CREATE TYPE "public"."profile_kind" AS ENUM('personal', 'business');--> statement-breakpoint
CREATE TABLE "beneficial_owner" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_profile_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"ownership_percent" numeric(5, 2)
);
--> statement-breakpoint
CREATE TABLE "business_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"legal_business_name" text NOT NULL,
	"entity_type" text NOT NULL,
	"ein_or_ssn_ref" text,
	"business_address" jsonb,
	"verification_tier" text DEFAULT 'none' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_staff_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_profile_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"custom_role_id" uuid,
	"is_authorized_representative" boolean DEFAULT false NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"permissions" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "device_session_session_token_hash_unique" UNIQUE("session_token_hash")
);
--> statement-breakpoint
CREATE TABLE "personal_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"legal_name" text,
	"residential_address" jsonb,
	"verification_tier" text DEFAULT 'none' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_profile_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "user_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"auth_credential_ref" text NOT NULL,
	"date_of_birth" text,
	"status" text DEFAULT 'active' NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_account_email_unique" UNIQUE("email"),
	CONSTRAINT "user_account_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"actor_role" text,
	"profile_kind" "profile_kind",
	"profile_id" uuid,
	"agreement_id" uuid,
	"action" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"device_info" jsonb,
	"previous_value" jsonb,
	"new_value" jsonb,
	"reason" text,
	"auth_strength" text,
	"related_document_id" uuid,
	"related_case_id" uuid,
	"event_hash" text NOT NULL,
	"previous_event_hash" text
);
--> statement-breakpoint
CREATE TABLE "early_access_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"account_type" "early_access_account_type" NOT NULL,
	"business_name" text,
	"state" text NOT NULL,
	"intended_use" text NOT NULL,
	"expected_agreements_per_month" integer NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"consent_version" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "early_access_leads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "beneficial_owner" ADD CONSTRAINT "beneficial_owner_business_profile_id_business_profile_id_fk" FOREIGN KEY ("business_profile_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_profile" ADD CONSTRAINT "business_profile_owner_user_id_user_account_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_staff_member" ADD CONSTRAINT "business_staff_member_business_profile_id_business_profile_id_fk" FOREIGN KEY ("business_profile_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_staff_member" ADD CONSTRAINT "business_staff_member_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_staff_member" ADD CONSTRAINT "business_staff_member_custom_role_id_custom_role_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."custom_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_role" ADD CONSTRAINT "custom_role_business_profile_id_business_profile_id_fk" FOREIGN KEY ("business_profile_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_session" ADD CONSTRAINT "device_session_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_profile" ADD CONSTRAINT "personal_profile_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_user_account_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_profile_owner_name_unique" ON "business_profile" USING btree ("owner_user_id","legal_business_name");--> statement-breakpoint
CREATE UNIQUE INDEX "business_staff_member_business_user_unique" ON "business_staff_member" USING btree ("business_profile_id","user_id");--> statement-breakpoint
CREATE INDEX "audit_event_agreement_idx" ON "audit_event" USING btree ("agreement_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_event_profile_idx" ON "audit_event" USING btree ("profile_kind","profile_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "early_access_leads_email_unique" ON "early_access_leads" USING btree ("email");--> statement-breakpoint
-- Sprint 1 (docs/sprints/SPRINT_01_PublicPreview _VercelReadiness.md item 7): public
-- visitors may INSERT only through the controlled application path and must not be
-- able to SELECT this table. This is written for a Supabase-hosted Postgres instance,
-- where the "anon" and "authenticated" roles are what Supabase's auto-generated
-- PostgREST API uses for unauthenticated/logged-in requests respectively, and Supabase
-- projects commonly grant those roles broad default privileges on new public-schema
-- tables. Explicitly revoking those privileges and adding no permissive policy for
-- either role means this table has zero surface area through Supabase's REST API,
-- regardless of anyone's anon key. The application's own writes
-- (src/app/api/early-access/route.ts, via src/db/client.ts) must connect using
-- DATABASE_URL configured to the Supabase project's owner/direct-connection role (or
-- any role with the BYPASSRLS attribute) — never the anon or authenticated role — so
-- that "the controlled application path" is structurally the only path that can write.
REVOKE ALL ON "early_access_leads" FROM anon, authenticated;--> statement-breakpoint
-- No CREATE POLICY statement is added for anon/authenticated on purpose: with RLS
-- enabled (above) and zero policies, every command (SELECT/INSERT/UPDATE/DELETE) is
-- denied by default for any role that isn't the table owner or BYPASSRLS, which is the
-- desired "no SELECT, no direct INSERT" outcome for public visitors.