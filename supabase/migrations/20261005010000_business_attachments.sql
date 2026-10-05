-- "PAID2YOU — SECURE BUSINESS ATTACHMENTS ITERATION" (2026-10-05): wires up the `organization_document`
-- table that a prior phase (DB-14) already prepared with the correct shape (organization-scoped,
-- `document_type` already the required Invoice/Bill of Lading/Proof of Delivery/Rate Confirmation/
-- Purchase Order/Statement/Contract/Supporting Document/Other vocabulary, already linked to
-- `agreement`/`business_customer`) but that no repository/service/route ever used. Only genuinely new
-- additive change: a nullable link to `business_obligation` ("Outstanding Balance"), the third
-- required attachment parent, plus a CHECK enforcing at most one parent link per document, plus
-- lookup indexes, plus a new, dedicated, private Storage bucket (never public, no object-level RLS —
-- mirrors 20260811131200_storage_buckets.sql's own already-accepted "access control lives entirely
-- server-side before Storage is ever called" precedent).
ALTER TABLE "organization_document" ADD COLUMN "related_obligation_id" uuid;--> statement-breakpoint
ALTER TABLE "organization_document" ADD CONSTRAINT "organization_document_related_obligation_id_business_obligation_id_fk" FOREIGN KEY ("related_obligation_id") REFERENCES "public"."business_obligation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_document" ADD CONSTRAINT "organization_document_single_related_parent" CHECK (
	(CASE WHEN "related_agreement_id" IS NULL THEN 0 ELSE 1 END
	+ CASE WHEN "related_customer_id" IS NULL THEN 0 ELSE 1 END
	+ CASE WHEN "related_obligation_id" IS NULL THEN 0 ELSE 1 END) <= 1
);--> statement-breakpoint
CREATE INDEX "organization_document_organization_id_idx" ON "organization_document" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_document_related_agreement_id_idx" ON "organization_document" USING btree ("related_agreement_id");--> statement-breakpoint
CREATE INDEX "organization_document_related_customer_id_idx" ON "organization_document" USING btree ("related_customer_id");--> statement-breakpoint
CREATE INDEX "organization_document_related_obligation_id_idx" ON "organization_document" USING btree ("related_obligation_id");--> statement-breakpoint
insert into storage.buckets (id, name, public)
values ('organization-documents', 'organization-documents', false)
on conflict (id) do nothing;
