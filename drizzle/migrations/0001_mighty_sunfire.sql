CREATE TYPE "public"."mfa_method" AS ENUM('totp', 'sms', 'passkey');--> statement-breakpoint
CREATE TABLE "email_verification_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "email_verification_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "email_verification_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mfa_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"method" "mfa_method" NOT NULL,
	"code_hash" text,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mfa_challenge" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mfa_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"method" "mfa_method" NOT NULL,
	"secret_ref" text,
	"phone_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mfa_credential" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "password_reset_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "password_reset_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "password_reset_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "step_up_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "step_up_verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "beneficial_owner" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "business_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "business_staff_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "custom_role" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "device_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "personal_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_account" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_account" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_verification_token" ADD CONSTRAINT "email_verification_token_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_challenge" ADD CONSTRAINT "mfa_challenge_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_credential" ADD CONSTRAINT "mfa_credential_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up_verification" ADD CONSTRAINT "step_up_verification_session_id_device_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."device_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Sprint 2 (docs/sprints/SPRINT_02_Authentication.md): same RLS lockdown
-- rationale as Sprint 1's early_access_leads migration (0000_nervous_speedball.sql)
-- — RLS is enabled above with zero permissive policies for anon/authenticated,
-- and this REVOKE is defense in depth against Supabase's default-privilege
-- auto-grants on new public-schema tables. This application's own code only
-- ever reaches these tables server-side through src/db/client.ts, using a
-- DATABASE_URL role that must be the project owner/direct-connection role
-- (or any BYPASSRLS role) — never anon or authenticated — for auth to work
-- at all. See docs/ENVIRONMENT_VARIABLES.md.
REVOKE ALL ON "user_account" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "personal_profile" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "business_profile" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "business_staff_member" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "custom_role" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "beneficial_owner" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "device_session" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "email_verification_token" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "password_reset_token" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "mfa_credential" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "mfa_challenge" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "step_up_verification" FROM anon, authenticated;