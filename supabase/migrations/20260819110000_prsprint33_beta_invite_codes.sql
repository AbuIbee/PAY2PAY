-- PRSprint 33 (docs/prsprints/PRSPRINT_33_FINAL_PRODUCTION_LAUNCH_CONTROLS_CLOSED_BETA.md): single-use
-- closed-beta invite codes (master-spec items 153/199, "financial launch should be phased... use a
-- small controlled cohort"). Only enforced when the closedBetaEnabled feature flag is on (default
-- false). RLS enabled with zero CREATE POLICY statements (deny-all for anon/authenticated), matching
-- every other table in this schema (PRSprint 02's established precedent — the app's own DB connection
-- queries as table owner and bypasses RLS regardless). REVOKE added by hand, matching every prior
-- migration.
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
ALTER TABLE "beta_invite_code" ADD CONSTRAINT "beta_invite_code_used_by_user_id_user_account_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "public"."user_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
REVOKE ALL ON TABLE "beta_invite_code" FROM anon, authenticated;
