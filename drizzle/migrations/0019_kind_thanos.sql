CREATE TYPE "public"."financial_account_status" AS ENUM('pending_verification', 'verified', 'failed', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."financial_account_type" AS ENUM('bank_account', 'debit_card');--> statement-breakpoint
CREATE TYPE "public"."financial_account_usage" AS ENUM('funding', 'payout');--> statement-breakpoint
CREATE TYPE "public"."relationship_financial_account_assignment_status" AS ENUM('active', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."relationship_invitation_status" AS ENUM('sent', 'viewed', 'accepted', 'declined', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."relationship_participant_status" AS ENUM('invited', 'linked', 'active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."relationship_status" AS ENUM('invited', 'counterparty_linked', 'identities_confirmed', 'financial_setup_pending', 'financial_accounts_ready', 'agreement_pending', 'agreement_ready', 'signature_pending', 'signed', 'active', 'restricted', 'suspended', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE "relationship" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "relationship_status" DEFAULT 'invited' NOT NULL,
	"context" text DEFAULT 'repayment_agreement' NOT NULL,
	"initiator_user_id" uuid NOT NULL,
	"current_agreement_id" uuid,
	"activated_at" timestamp with time zone,
	"restricted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relationship" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "relationship_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"inviter_user_id" uuid NOT NULL,
	"invitee_email" text NOT NULL,
	"invitee_role" "agreement_party_role" NOT NULL,
	"status" "relationship_invitation_status" DEFAULT 'sent' NOT NULL,
	"token_hash" text NOT NULL,
	"resolved_invitee_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"viewed_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relationship_invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "relationship_participant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"individual_profile_id" uuid,
	"organization_id" uuid,
	"role" "agreement_party_role" NOT NULL,
	"status" "relationship_participant_status" DEFAULT 'invited' NOT NULL,
	"represented_by_user_id" uuid,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationship_participant_exactly_one_party" CHECK (("relationship_participant"."individual_profile_id" IS NOT NULL AND "relationship_participant"."organization_id" IS NULL) OR ("relationship_participant"."individual_profile_id" IS NULL AND "relationship_participant"."organization_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "relationship_participant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "financial_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"individual_profile_id" uuid,
	"organization_id" uuid,
	"account_type" "financial_account_type" NOT NULL,
	"provider_name" text NOT NULL,
	"provider_account_ref" text NOT NULL,
	"masked_last4" text,
	"institution_display_name" text,
	"status" "financial_account_status" DEFAULT 'pending_verification' NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_account_exactly_one_party" CHECK (("financial_account"."individual_profile_id" IS NOT NULL AND "financial_account"."organization_id" IS NULL) OR ("financial_account"."individual_profile_id" IS NULL AND "financial_account"."organization_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "financial_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "relationship_financial_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"relationship_participant_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"usage" "financial_account_usage" NOT NULL,
	"status" "relationship_financial_account_assignment_status" DEFAULT 'active' NOT NULL,
	"selected_by_user_id" uuid NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relationship_financial_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agreement" ADD COLUMN "relationship_id" uuid;--> statement-breakpoint
ALTER TABLE "ach_mandate" ADD COLUMN "financial_account_id" uuid;--> statement-breakpoint
ALTER TABLE "debit_card_method" ADD COLUMN "financial_account_id" uuid;--> statement-breakpoint
ALTER TABLE "relationship" ADD CONSTRAINT "relationship_initiator_user_id_user_account_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_invitation" ADD CONSTRAINT "relationship_invitation_relationship_id_relationship_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."relationship"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_invitation" ADD CONSTRAINT "relationship_invitation_inviter_user_id_user_account_id_fk" FOREIGN KEY ("inviter_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_invitation" ADD CONSTRAINT "relationship_invitation_resolved_invitee_user_id_user_account_id_fk" FOREIGN KEY ("resolved_invitee_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_participant" ADD CONSTRAINT "relationship_participant_relationship_id_relationship_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."relationship"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_participant" ADD CONSTRAINT "relationship_participant_individual_profile_id_personal_profile_id_fk" FOREIGN KEY ("individual_profile_id") REFERENCES "public"."personal_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_participant" ADD CONSTRAINT "relationship_participant_organization_id_business_profile_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_participant" ADD CONSTRAINT "relationship_participant_represented_by_user_id_user_account_id_fk" FOREIGN KEY ("represented_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_account" ADD CONSTRAINT "financial_account_individual_profile_id_personal_profile_id_fk" FOREIGN KEY ("individual_profile_id") REFERENCES "public"."personal_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_account" ADD CONSTRAINT "financial_account_organization_id_business_profile_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_account" ADD CONSTRAINT "financial_account_added_by_user_id_user_account_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_financial_account" ADD CONSTRAINT "relationship_financial_account_relationship_id_relationship_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."relationship"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_financial_account" ADD CONSTRAINT "relationship_financial_account_relationship_participant_id_relationship_participant_id_fk" FOREIGN KEY ("relationship_participant_id") REFERENCES "public"."relationship_participant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_financial_account" ADD CONSTRAINT "relationship_financial_account_financial_account_id_financial_account_id_fk" FOREIGN KEY ("financial_account_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_financial_account" ADD CONSTRAINT "relationship_financial_account_selected_by_user_id_user_account_id_fk" FOREIGN KEY ("selected_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_participant_relationship_role_unique" ON "relationship_participant" USING btree ("relationship_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_financial_account_active_slot_unique" ON "relationship_financial_account" USING btree ("relationship_id","usage") WHERE "relationship_financial_account"."status" = 'active';--> statement-breakpoint
ALTER TABLE "agreement" ADD CONSTRAINT "agreement_relationship_id_relationship_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."relationship"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ach_mandate" ADD CONSTRAINT "ach_mandate_financial_account_id_financial_account_id_fk" FOREIGN KEY ("financial_account_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debit_card_method" ADD CONSTRAINT "debit_card_method_financial_account_id_financial_account_id_fk" FOREIGN KEY ("financial_account_id") REFERENCES "public"."financial_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
REVOKE ALL ON "relationship" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "relationship_invitation" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "relationship_participant" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "financial_account" FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "relationship_financial_account" FROM anon, authenticated;