CREATE TYPE "public"."approval_request_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."staff_invitation_status" AS ENUM('pending', 'accepted', 'expired', 'revoked');--> statement-breakpoint
CREATE TABLE "business_approval_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_profile_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"threshold_minor_units" integer,
	"requires_dual_approval" boolean DEFAULT false NOT NULL,
	"requires_owner" boolean DEFAULT false NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_approval_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "business_staff_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_profile_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"custom_role_id" uuid,
	"invited_by_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" "staff_invitation_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_staff_invitation_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "business_staff_invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_approval_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_profile_id" uuid NOT NULL,
	"proposed_by_staff_id" uuid NOT NULL,
	"related_agreement_id" uuid,
	"action_type" text NOT NULL,
	"action_payload" jsonb NOT NULL,
	"reason_flagged" text NOT NULL,
	"status" "approval_request_status" DEFAULT 'pending' NOT NULL,
	"approved_by_staff_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_approval_request_no_self_approval" CHECK ("staff_approval_request"."approved_by_staff_id" IS NULL OR "staff_approval_request"."approved_by_staff_id" <> "staff_approval_request"."proposed_by_staff_id")
);
--> statement-breakpoint
ALTER TABLE "staff_approval_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "business_approval_policy" ADD CONSTRAINT "business_approval_policy_business_profile_id_business_profile_id_fk" FOREIGN KEY ("business_profile_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_approval_policy" ADD CONSTRAINT "business_approval_policy_updated_by_user_id_user_account_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_staff_invitation" ADD CONSTRAINT "business_staff_invitation_business_profile_id_business_profile_id_fk" FOREIGN KEY ("business_profile_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_staff_invitation" ADD CONSTRAINT "business_staff_invitation_custom_role_id_custom_role_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."custom_role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_staff_invitation" ADD CONSTRAINT "business_staff_invitation_invited_by_user_id_user_account_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_staff_invitation" ADD CONSTRAINT "business_staff_invitation_accepted_by_user_id_user_account_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_approval_request" ADD CONSTRAINT "staff_approval_request_business_profile_id_business_profile_id_fk" FOREIGN KEY ("business_profile_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_approval_request" ADD CONSTRAINT "staff_approval_request_proposed_by_staff_id_business_staff_member_id_fk" FOREIGN KEY ("proposed_by_staff_id") REFERENCES "public"."business_staff_member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_approval_request" ADD CONSTRAINT "staff_approval_request_approved_by_staff_id_business_staff_member_id_fk" FOREIGN KEY ("approved_by_staff_id") REFERENCES "public"."business_staff_member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_approval_policy_business_capability_unique" ON "business_approval_policy" USING btree ("business_profile_id","capability");--> statement-breakpoint
CREATE UNIQUE INDEX "business_staff_invitation_business_email_pending_unique" ON "business_staff_invitation" USING btree ("business_profile_id","email") WHERE "business_staff_invitation"."status" = 'pending';--> statement-breakpoint
-- Sprint 4 (docs/sprints/SPRINT_04_BusinessStaff_Permissions.md): same RLS
-- lockdown rationale as every prior migration in this project (see
-- 0000_nervous_speedball.sql's comment) — RLS is enabled above with zero
-- permissive policies for anon/authenticated, and this REVOKE is defense in
-- depth against Supabase's default-privilege auto-grants on new
-- public-schema tables.
REVOKE ALL ON "business_approval_policy" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "business_staff_invitation" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "staff_approval_request" FROM anon, authenticated;