CREATE TYPE "public"."admin_restriction_type" AS ENUM('payment_activity', 'new_agreement_creation', 'payout');--> statement-breakpoint
CREATE TYPE "public"."appeal_decision" AS ENUM('upheld', 'overturned', 'partially_overturned');--> statement-breakpoint
CREATE TYPE "public"."appeal_status" AS ENUM('submitted', 'under_review', 'decided');--> statement-breakpoint
CREATE TYPE "public"."internal_admin_role" AS ENUM('support', 'compliance', 'fraud_reviewer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."retention_hold_type" AS ENUM('retention', 'dispute', 'fraud_review', 'litigation', 'administrative_override');--> statement-breakpoint
CREATE TYPE "public"."support_case_status" AS ENUM('open', 'in_review', 'resolved', 'closed');--> statement-breakpoint
CREATE TABLE "admin_restriction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restriction_type" "admin_restriction_type" NOT NULL,
	"target_resource_type" text NOT NULL,
	"target_resource_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"case_reference" text,
	"placed_by_user_id" uuid NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_by_user_id" uuid,
	"lifted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "admin_restriction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "admin_role_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "internal_admin_role" NOT NULL,
	"assigned_by_user_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by_user_id" uuid,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "admin_role_assignment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "appeal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appealing_user_id" uuid NOT NULL,
	"target_resource_type" text NOT NULL,
	"target_resource_id" uuid NOT NULL,
	"original_decision_summary" text NOT NULL,
	"original_decision_by_user_id" uuid,
	"evidence_description" text,
	"status" "appeal_status" DEFAULT 'submitted' NOT NULL,
	"reviewer_user_id" uuid,
	"decision" "appeal_decision",
	"rationale" text,
	"decided_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appeal_reviewer_not_original_decision_maker" CHECK ("appeal"."reviewer_user_id" IS NULL OR "appeal"."original_decision_by_user_id" IS NULL OR "appeal"."reviewer_user_id" <> "appeal"."original_decision_by_user_id")
);
--> statement-breakpoint
ALTER TABLE "appeal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "retention_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_resource_type" text NOT NULL,
	"target_resource_id" uuid NOT NULL,
	"hold_type" "retention_hold_type" NOT NULL,
	"reason" text NOT NULL,
	"placed_by_user_id" uuid NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by_user_id" uuid,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "retention_hold" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "support_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"opened_by_user_id" uuid,
	"category" text,
	"summary" text NOT NULL,
	"status" "support_case_status" DEFAULT 'open' NOT NULL,
	"resolution_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "support_case" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_restriction" ADD CONSTRAINT "admin_restriction_placed_by_user_id_user_account_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_restriction" ADD CONSTRAINT "admin_restriction_lifted_by_user_id_user_account_id_fk" FOREIGN KEY ("lifted_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_assignment" ADD CONSTRAINT "admin_role_assignment_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_assignment" ADD CONSTRAINT "admin_role_assignment_assigned_by_user_id_user_account_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_assignment" ADD CONSTRAINT "admin_role_assignment_revoked_by_user_id_user_account_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_appealing_user_id_user_account_id_fk" FOREIGN KEY ("appealing_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_original_decision_by_user_id_user_account_id_fk" FOREIGN KEY ("original_decision_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeal" ADD CONSTRAINT "appeal_reviewer_user_id_user_account_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_hold" ADD CONSTRAINT "retention_hold_placed_by_user_id_user_account_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_hold" ADD CONSTRAINT "retention_hold_released_by_user_id_user_account_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_subject_user_id_user_account_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_case" ADD CONSTRAINT "support_case_opened_by_user_id_user_account_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_restriction_active_target_unique" ON "admin_restriction" USING btree ("target_resource_type","target_resource_id","restriction_type") WHERE "admin_restriction"."lifted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_role_assignment_active_user_unique" ON "admin_role_assignment" USING btree ("user_id") WHERE "admin_role_assignment"."revoked_at" IS NULL;--> statement-breakpoint
REVOKE ALL ON "admin_restriction" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "admin_role_assignment" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "appeal" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "retention_hold" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "support_case" FROM anon, authenticated;