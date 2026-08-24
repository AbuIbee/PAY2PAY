ALTER TABLE "relationship" ADD COLUMN "public_reference" text;--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_public_reference_unique" ON "relationship" USING btree ("public_reference");