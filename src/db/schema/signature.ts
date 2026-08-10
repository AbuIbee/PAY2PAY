import { sql } from "drizzle-orm";
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agreementVersion } from "./agreement";
import { agreementPartyRoleEnum, mfaMethodEnum, profileKindEnum, signingAuthorityEnum } from "./enums";
import { userAccount } from "./identity";

/**
 * Sprint 6 (docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md) electronic-signature
 * evidence bundle — supersedes/layers on top of Sprint 5's minimal version-scoped signing-intent
 * primitive (agreement_version.creditor_signed_at/debtor_signed_at), which is unchanged and still
 * the source of truth for "has this role signed". This table captures the full evidence record the
 * sprint requires per individual signature: who, under what profile/role/authority, how they
 * authenticated, when/where/on-what-device, what consent text version they agreed to, and a hash of
 * the exact terms they were signing (agreement_hash_at_signing) — independent of
 * agreement_version.document_hash, which is only set once *both* parties have signed.
 */
export const signatureEvent = pgTable(
  "signature_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    agreementVersionId: uuid("agreement_version_id")
      .notNull()
      .references(() => agreementVersion.id),
    signerUserId: uuid("signer_user_id")
      .notNull()
      .references(() => userAccount.id),
    signerProfileKind: profileKindEnum("signer_profile_kind").notNull(),
    signerProfileId: uuid("signer_profile_id").notNull(),
    signerRole: agreementPartyRoleEnum("signer_role").notNull(),
    // Business-signer authority evidence (FR-B2B-002/003) — null for a personal-profile signer.
    signingAuthority: signingAuthorityEnum("signing_authority"),
    signerTitle: text("signer_title"), // business representative's staff role/title, if applicable
    consentCaptured: boolean("consent_captured").notNull(),
    consentVersion: text("consent_version").notNull(),
    authMethod: mfaMethodEnum("auth_method").notNull(),
    ipAddress: text("ip_address").notNull(),
    deviceInfo: jsonb("device_info"),
    timezone: text("timezone").notNull(),
    agreementHashAtSigning: text("agreement_hash_at_signing").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One signature event per role per version — mirrors agreement_party's own unique constraint
    // and gives the DB, not just AgreementService's application-layer check, a second guarantee
    // against double-recording a signature for the same role.
    uniqueIndex("signature_event_version_role_unique").on(table.agreementVersionId, table.signerRole),
  ],
).enableRLS();

/**
 * Sprint 6: one immutable, stable PDF per fully-signed agreement version — generated exactly once,
 * automatically, the moment both parties' signatures are captured (never regenerated afterward,
 * matching "Implement immutable versioning"). `storagePath` points into a private Supabase Storage
 * bucket (src/lib/documents/documentStorage.ts) — never a public URL; access is always through a
 * freshly issued, authorization-checked signed URL (src/lib/signatures/signatureService.ts).
 */
export const agreementPdf = pgTable(
  "agreement_pdf",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    agreementVersionId: uuid("agreement_version_id")
      .notNull()
      .references(() => agreementVersion.id),
    storagePath: text("storage_path").notNull(),
    documentHash: text("document_hash").notNull(),
    // Reserved placeholder (this sprint's explicit "payment authorization placeholder" requirement)
    // — always null until Sprint 9+ implements real payment authorization. Not read or written by
    // any code path in this sprint.
    paymentAuthorizationRef: text("payment_authorization_ref"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("agreement_pdf_version_unique").on(table.agreementVersionId)],
).enableRLS();
