import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agreement, agreementVersion } from "./agreement";
import { agreementPartyRoleEnum, profileKindEnum } from "./enums";

/**
 * Decision 7 (canonical connection/profile remediation — agreement identity snapshot): the
 * structured, immutable record of what each party's agreement-facing identity looked like at the
 * moment their acceptance became legally meaningful. Reason (per the approved design): an already
 * accepted/signed agreement must never silently change what it displays just because a party later
 * edits their name/email/city/state/ZIP in their own profile — "the information the parties review/
 * sign must not change between acceptance and signature," and must never drift afterward either.
 *
 * Timing (Decision 7's own explicit instruction): frozen when Step 2 — Review & Acceptance completes
 * and the accepted agreement VERSION enters `awaiting_signatures` — never deferred until both
 * signatures are collected. One row per (agreement_version_id, role); an amendment that produces a
 * new version and requires renewed acceptance gets its OWN new snapshot rows, never overwriting the
 * prior version's — every version's snapshot remains independently, permanently retrievable, exactly
 * like `agreement_version` itself is never mutated after creation.
 *
 * `source_profile_id` is internal audit/reference information only — never printed in the agreement
 * or PDF (Decision 7's own explicit instruction); the display fields below are the only ones any
 * agreement-facing UI or document may read.
 */
export const agreementPartySnapshot = pgTable(
  "agreement_party_snapshot",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    agreementId: uuid("agreement_id")
      .notNull()
      .references(() => agreement.id),
    agreementVersionId: uuid("agreement_version_id")
      .notNull()
      .references(() => agreementVersion.id),
    role: agreementPartyRoleEnum("role").notNull(),
    profileKind: profileKindEnum("profile_kind").notNull(),
    // Internal audit/reference only — see this table's own doc comment. Never selected into any
    // agreement-facing or PDF-facing read path.
    sourceProfileId: uuid("source_profile_id").notNull(),
    displayName: text("display_name").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    preferredEmail: text("preferred_email"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postal_code"),
    country: text("country"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("agreement_party_snapshot_version_role_unique").on(table.agreementVersionId, table.role)],
).enableRLS();
