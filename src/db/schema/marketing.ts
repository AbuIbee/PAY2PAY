import { sql } from "drizzle-orm";
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { earlyAccessAccountTypeEnum } from "./enums";

/**
 * Sprint 1 (docs/sprints/SPRINT_01_PublicPreview _VercelReadiness.md) early-access
 * lead capture — the only database-backed feature in scope for the public-preview
 * deployment. Deliberately collects none of the fields Sprint 1 explicitly
 * forbids (bank account, routing number, SSN, EIN, payment card, government ID).
 *
 * `.enableRLS()` plus the policies in the accompanying migration are defense in
 * depth for Supabase's auto-generated PostgREST API surface — this application's
 * own code only ever reaches this table server-side through src/db/client.ts, but
 * a Supabase-hosted table without RLS is otherwise readable by anyone with the
 * project's anon key via that API, independent of this app's own access pattern.
 */
export const earlyAccessLead = pgTable(
  "early_access_leads",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    // Lowercased by the caller before insert (same convention as user_account.email).
    email: text("email").notNull(),
    accountType: earlyAccessAccountTypeEnum("account_type").notNull(),
    businessName: text("business_name"),
    state: text("state").notNull(),
    intendedUse: text("intended_use").notNull(),
    expectedAgreementsPerMonth: integer("expected_agreements_per_month").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set server-side only, never from client input (src/app/api/early-access/route.ts).
    source: text("source").notNull(),
    consentVersion: text("consent_version").notNull(),
  },
  (table) => [
    // Duplicate-submission handling (Sprint 1 item 8): a second submission from
    // the same email updates the existing row (ON CONFLICT) instead of creating
    // a second lead record.
    uniqueIndex("early_access_leads_email_unique").on(table.email),
  ],
).enableRLS();
