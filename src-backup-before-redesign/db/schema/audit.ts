import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    eventHash: text("event_hash").notNull(),
    previousEventHash: text("previous_event_hash"),
  },
  (table) => [
    index("audit_event_agreement_idx").on(table.agreementId, table.occurredAt),
    index("audit_event_profile_idx").on(table.profileKind, table.profileId, table.occurredAt),
  ],
);
