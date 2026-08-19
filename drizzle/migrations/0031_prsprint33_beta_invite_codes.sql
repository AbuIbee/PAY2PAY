CREATE TABLE "beta_invite_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"used_by_user_id" uuid,
	"used_at" timestamp with time zone,
	CONSTRAINT "beta_invite_code_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "beta_invite_code" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "beta_invite_code" ADD CONSTRAINT "beta_invite_code_created_by_user_id_user_account_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beta_invite_code" ADD CONSTRAINT "beta_invite_code_used_by_user_id_user_account_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;