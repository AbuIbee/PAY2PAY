CREATE TABLE "sms_consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"consented_phone_e164" text,
	"consented_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"source" text,
	"disclosure_version" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_consent_active_requires_phone" CHECK ("sms_consent"."active" = false OR "sms_consent"."consented_phone_e164" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "sms_consent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sms_consent" ADD CONSTRAINT "sms_consent_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_consent_user_id_unique" ON "sms_consent" USING btree ("user_id");
