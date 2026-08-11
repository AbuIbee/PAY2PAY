CREATE TYPE "public"."account_classification" AS ENUM('production', 'internal', 'qa', 'demo', 'automated_test');--> statement-breakpoint
CREATE TYPE "public"."platform_role" AS ENUM('member', 'platform_admin', 'platform_owner');--> statement-breakpoint
CREATE TABLE "admin_impersonation_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "admin_impersonation_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_account" ADD COLUMN "platform_role" "platform_role" DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_account" ADD COLUMN "account_classification" "account_classification" DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_event" ADD COLUMN "target_resource_type" text;--> statement-breakpoint
ALTER TABLE "audit_event" ADD COLUMN "target_resource_id" text;--> statement-breakpoint
ALTER TABLE "admin_impersonation_session" ADD CONSTRAINT "admin_impersonation_session_admin_user_id_user_account_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_impersonation_session" ADD CONSTRAINT "admin_impersonation_session_target_user_id_user_account_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Sprint 6A (docs/sprints/SPRINT_06A_Platform_Administration_Audit_Control.md): same RLS
-- lockdown rationale as every prior migration in this project (see
-- 0000_nervous_speedball.sql's comment) — RLS is enabled above with zero
-- permissive policies for anon/authenticated, and this REVOKE is defense in
-- depth against Supabase's default-privilege auto-grants on new
-- public-schema tables.
REVOKE ALL ON "admin_impersonation_session" FROM anon, authenticated;
