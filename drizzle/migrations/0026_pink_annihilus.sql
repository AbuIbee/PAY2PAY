CREATE TYPE "public"."agreement_invitation_status" AS ENUM('pending', 'viewed', 'accepted', 'declined', 'expired', 'revoked');--> statement-breakpoint
CREATE TABLE "agreement_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inviter_user_id" uuid NOT NULL,
	"inviter_profile_kind" "profile_kind" NOT NULL,
	"inviter_profile_id" uuid NOT NULL,
	"inviter_role" "agreement_party_role" NOT NULL,
	"recipient_name" text,
	"recipient_email" text,
	"recipient_phone" text,
	"recipient_user_id" uuid,
	"recipient_profile_kind" "profile_kind",
	"recipient_profile_id" uuid,
	"agreement_id" uuid,
	"currency" text DEFAULT 'USD' NOT NULL,
	"frequency" "payment_frequency" NOT NULL,
	"fee_allocation" "fee_allocation" NOT NULL,
	"proposed_terms" jsonb NOT NULL,
	"message" text,
	"proposal_version" integer DEFAULT 1 NOT NULL,
	"token_hash" text NOT NULL,
	"status" "agreement_invitation_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agreement_invitation" ADD CONSTRAINT "agreement_invitation_inviter_user_id_user_account_id_fk" FOREIGN KEY ("inviter_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_invitation" ADD CONSTRAINT "agreement_invitation_recipient_user_id_user_account_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_invitation" ADD CONSTRAINT "agreement_invitation_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agreement_invitation_token_hash_unique" ON "agreement_invitation" USING btree ("token_hash");--> statement-breakpoint
REVOKE ALL ON "agreement_invitation" FROM anon, authenticated;