-- Closed-Beta Critical Remediation (DEF-UAT-006): notification_event previously had no way to carry a
-- relationship-invitation reference, so the relationship_invitation notification template had nothing
-- to build an actionable link from — an invited user had no discoverable way to accept a connection
-- invitation anywhere in the product (no link in the email, SMS, or in-app notification). Mirrors
-- related_agreement_id's identical existing pattern. No REVOKE needed here (already applied to
-- notification_event at table-creation time; this only adds a column to an existing, already-locked-
-- down table).
ALTER TABLE "notification_event" ADD COLUMN "related_invitation_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_event" ADD CONSTRAINT "notification_event_related_invitation_id_relationship_invitation_id_fk" FOREIGN KEY ("related_invitation_id") REFERENCES "public"."relationship_invitation"("id") ON DELETE no action ON UPDATE no action;
