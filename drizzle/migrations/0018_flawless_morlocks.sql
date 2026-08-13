CREATE TYPE "public"."notification_channel" AS ENUM('email', 'sms', 'in_app');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE "notification_preference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"notification_type" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_preference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_event" ADD COLUMN "channel" "notification_channel" DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_event" ADD COLUMN "status" "notification_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_event" ADD COLUMN "critical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_event" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "notification_event" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "notification_event" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_event" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preference_user_type_channel_unique" ON "notification_preference" USING btree ("user_id","notification_type","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_event_dedupe_key_unique" ON "notification_event" USING btree ("dedupe_key");--> statement-breakpoint
REVOKE ALL ON "notification_preference" FROM anon, authenticated;