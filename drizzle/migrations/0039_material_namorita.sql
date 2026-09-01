CREATE TABLE "preferred_email_verification_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"personal_profile_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preferred_email_verification_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "preferred_email_verification_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "preferred_email_verification_token" ADD CONSTRAINT "preferred_email_verification_token_personal_profile_id_personal_profile_id_fk" FOREIGN KEY ("personal_profile_id") REFERENCES "public"."personal_profile"("id") ON DELETE no action ON UPDATE no action;