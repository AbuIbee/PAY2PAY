CREATE TYPE "public"."bank_link_attempt_status" AS ENUM('pending', 'completed', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "bank_link_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_session_id" text NOT NULL,
	"acting_user_id" uuid NOT NULL,
	"party_profile_kind" "profile_kind" NOT NULL,
	"party_individual_profile_id" uuid,
	"party_organization_id" uuid,
	"shopper_reference" text NOT NULL,
	"existing_stored_payment_method_ids" text[] NOT NULL,
	"status" "bank_link_attempt_status" DEFAULT 'pending' NOT NULL,
	"result_financial_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "bank_link_attempt_provider_session_id_unique" UNIQUE("provider_session_id"),
	CONSTRAINT "bank_link_attempt_exactly_one_party" CHECK (("bank_link_attempt"."party_individual_profile_id" IS NOT NULL AND "bank_link_attempt"."party_organization_id" IS NULL) OR ("bank_link_attempt"."party_individual_profile_id" IS NULL AND "bank_link_attempt"."party_organization_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "bank_link_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bank_link_attempt" ADD CONSTRAINT "bank_link_attempt_acting_user_id_user_account_id_fk" FOREIGN KEY ("acting_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_link_attempt" ADD CONSTRAINT "bank_link_attempt_party_individual_profile_id_personal_profile_id_fk" FOREIGN KEY ("party_individual_profile_id") REFERENCES "public"."personal_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_link_attempt" ADD CONSTRAINT "bank_link_attempt_party_organization_id_business_profile_id_fk" FOREIGN KEY ("party_organization_id") REFERENCES "public"."business_profile"("id") ON DELETE no action ON UPDATE no action;