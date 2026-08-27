CREATE TYPE "public"."agreement_cancellation_request_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "agreement_cancellation_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"status" "agreement_cancellation_request_status" DEFAULT 'pending' NOT NULL,
	"requested_by_party_role" "agreement_party_role" NOT NULL,
	"requested_by_profile_kind" "profile_kind" NOT NULL,
	"requested_by_profile_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"decided_by_profile_kind" "profile_kind",
	"decided_by_profile_id" uuid,
	"rejected_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_cancellation_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agreement_cancellation_request" ADD CONSTRAINT "agreement_cancellation_request_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;