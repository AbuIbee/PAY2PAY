CREATE TABLE "agreement_party_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"agreement_version_id" uuid NOT NULL,
	"role" "agreement_party_role" NOT NULL,
	"profile_kind" "profile_kind" NOT NULL,
	"source_profile_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"preferred_email" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_party_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "personal_profile" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "personal_profile" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "personal_profile" ADD COLUMN "preferred_email" text;--> statement-breakpoint
ALTER TABLE "personal_profile" ADD COLUMN "preferred_email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "personal_profile" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "personal_profile" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agreement_party_snapshot" ADD CONSTRAINT "agreement_party_snapshot_agreement_id_agreement_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_party_snapshot" ADD CONSTRAINT "agreement_party_snapshot_agreement_version_id_agreement_version_id_fk" FOREIGN KEY ("agreement_version_id") REFERENCES "public"."agreement_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agreement_party_snapshot_version_role_unique" ON "agreement_party_snapshot" USING btree ("agreement_version_id","role");