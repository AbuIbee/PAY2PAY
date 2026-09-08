import { sql } from "drizzle-orm";
import { bigserial, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { profileKindEnum } from "./enums";
import { userAccount } from "./identity";

/**
 * Append-only audit trail (docs/DATA_MODEL.md §4/§6, FR-AUDIT-001–003).
 * `eventHash`/`previousEventHash` implement the hash-chaining described in
 * src/lib/audit/hash.ts. `agreementId`, `relatedDocumentId`, and
 * `relatedCaseId` are plain UUID columns without foreign keys because the
 * tables they will eventually reference (agreement, evidence_document,
 * appeal_case) don't exist yet in Phase 0 — matching the original
 * illustrative schema, which never FK-constrained them either.
 *
 * No UPDATE or DELETE grant is issued to the application's database role on
 * this table (enforced at the database/role-provisioning layer, outside
 * application code) — see docs/DATA_MODEL.md §6.
 */
/**
 * PRSprint 02 (docs/prsprints/PRSPRINT_02_RLS_CROSS_TENANT_SECURITY.md) gap fix: this table was
 * created in Phase 0 before every other table in this schema adopted `.enableRLS()`, and no later
 * migration ever added it here — only a REVOKE (see
 * supabase/migrations/20260811131300_audit_event_revoke_gap_fix.sql, whose own comment's claim that
 * "Row Level Security was already enabled ... via Supabase's own project-level default" was never
 * verified against this schema source, which never declared it). REVOKE alone already makes this
 * table unreachable by the anon/authenticated Postgres roles regardless of RLS state (Postgres
 * requires the base GRANT before any RLS predicate is even evaluated), so there was no live
 * cross-tenant exposure — but leaving the schema source silent on RLS for the one table where a
 * human had to reason about it by hand, instead of drizzle-kit generating it automatically like
 * every other table, is exactly the kind of drift this PRSprint exists to close.
 */
export const auditEvent = pgTable(
  "audit_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => userAccount.id),
    actorRole: text("actor_role"),
    profileKind: profileKindEnum("profile_kind"),
    profileId: uuid("profile_id"),
    agreementId: uuid("agreement_id"),
    action: text("action").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    // Stored as text rather than the native `inet` type for Phase 0 to avoid
    // depending on an unconfirmed drizzle-orm/pg type mapping; can migrate
    // to `inet` once verified against the target Postgres platform.
    ipAddress: text("ip_address"),
    deviceInfo: jsonb("device_info"),
    previousValue: jsonb("previous_value"),
    newValue: jsonb("new_value"),
    reason: text("reason"),
    authStrength: text("auth_strength"),
    relatedDocumentId: uuid("related_document_id"),
    relatedCaseId: uuid("related_case_id"),
    // Sprint 6A (docs/sprints/SPRINT_06A_Platform_Administration_Audit_Control.md): generic
    // target-resource identification for administrative actions (e.g. "user_account" / a specific
    // user's id) — nullable/optional so every pre-Sprint-6A call site is unaffected; text rather
    // than uuid since the target resource type varies (matches `action`'s own text column).
    targetResourceType: text("target_resource_type"),
    targetResourceId: text("target_resource_id"),
    eventHash: text("event_hash").notNull(),
    previousEventHash: text("previous_event_hash"),
    // R09 corrective pass (Codex blocker 9 — audit effect recovery/idempotency): a durable, stable
    // identity for a REQUIRED financial-transition audit effect, tied to the exact provider event
    // that caused it — never set for any other audit action. Lets a retry safely re-attempt writing
    // a missing required audit record (status committed, audit failed, retry restores it) via
    // insert-then-recheck-on-conflict, the same idiom used everywhere else in this codebase, WITHOUT
    // weakening R04's append-only hash-chain serialization at all: this is purely an additional,
    // orthogonal uniqueness check performed before the chain-serialized insert, never a change to
    // how the chain itself is built or verified. Nullable — every non-financial-transition audit
    // action (the overwhelming majority) never sets this.
    providerEventId: text("provider_event_id"),
  },
  (table) => [
    index("audit_event_agreement_idx").on(table.agreementId, table.occurredAt),
    index("audit_event_profile_idx").on(table.profileKind, table.profileId, table.occurredAt),
    // Partial unique index: only ever constrains the rows that opt into this identity (financial
    // transition audits tied to a provider event) — every other action's rows are entirely
    // unaffected, since `provider_event_id IS NULL` never participates in a unique index.
    uniqueIndex("audit_event_provider_event_action_unique")
      .on(table.providerEventId, table.action)
      .where(sql`${table.providerEventId} IS NOT NULL`),
  ],
).enableRLS();
