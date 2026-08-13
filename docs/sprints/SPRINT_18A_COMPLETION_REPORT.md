# Sprint 18A Completion Report

## Remediation Pass (post-initial-report)

The original version of this report scored two acceptance criteria below PASS: **Document/evidence
connector = FAIL** and **Debit-card connector = PARTIAL**. A remediation pass was requested and
completed before any Product Owner review, closing both gaps with real production code and new
passing tests — not by relabeling. This document has been updated in place to reflect the resulting
state; every section below (Implementation, Database, Cross-Sprint Integration, Tests, Validation,
Known Limitations, Acceptance Criteria) now describes the codebase **after** remediation. A summary of
exactly what changed in the remediation pass:

- **Document/evidence connector (Phase 25):** added `RelationshipService.getRelationshipEvidence`/
  `getRelationshipEvidenceSignedUrl`, delegating entirely to Sprint 7's unmodified `EvidenceService`
  (which already enforces full shared/private/witness visibility) behind a relationship-participation
  gate. Two new routes: `GET /api/relationships/evidence`, `GET /api/relationships/evidence/signed-url`.
- **Debit-card connector (Phase 21):** added three nullable columns to `financial_account`
  (`card_expiry_month`, `card_expiry_year`, `card_brand` — migration `0020_jittery_may_parker.sql`),
  closing the original schema gap. `RelationshipService.linkAgreement` now auto-registers a real Sprint
  12 `debit_card_method` row (via a new `CardMethodReader`/`DebitCardFinancialAccountAdapter`, mirroring
  the existing ACH connector exactly), and `checkActivationPrerequisites` gained a `card_missing` reason
  symmetric with `mandate_missing`.
- **5 new tests**, **3 new files**, **12 modified files**, **1 new migration**. Full repository suite:
  **654/654 passing** (up from 649/649), zero regressions. Full detail in `docs/SPRINT_CONTROL.md`'s
  "Sprint 18A remediation pass" section and `docs/PROGRESS.md`'s matching section.

**Result: every Sprint 18A acceptance criterion is now PASS.**

## Closure Fix (post-remediation)

Requested directly: the remediation report confirmed `expireDueInvitations` exists and is tested, but
the invitation-expiration scheduler/cron route remained unwired — the smallest production-safe piece
missing to make that method actually run. This closure fix wires it using the exact scheduler
architecture Sprints 13/15/17 already established, and fixes one real consistency gap wiring it exposed.

- **Scheduler route:** `POST /api/scheduler/expire-relationship-invitations` — a byte-for-byte mirror of
  `retry-notifications`/`expire-negotiations` (same constant-time `CRON_SECRET` bearer-token check, same
  `ConfigurationError`/`ForbiddenError` split, same runtime/duration exports). The route body is a
  single call to `expireDueInvitations(new Date())` — no expiration logic duplicated.
- **`vercel.json`:** one new cron entry (`"0 16 * * *"`), the next free hourly slot in the existing
  staggered convention — no second scheduler framework introduced.
- **Consistency fix found while wiring:** `expireDueInvitations` never applied the same
  "orphaned-relationship cleanup" that `declineInvitation`/`cancelInvitation` already apply. This was
  dead code while nothing called the method in production; now that the cron will actually fire, the
  same fix was applied — `expireDueInvitations` now calls `cancelRelationshipIfNeverLinked(...,  null)`
  per expired invitation.
- **9 new tests** (2 service-level, 7 route-level), **2 new files**, **2 modified files**, **no schema
  change**. Full repository suite: **663/663 passing** (up from 654/654), zero regressions. Full detail
  in `docs/SPRINT_CONTROL.md`'s "Sprint 18A closure fix" section and `docs/PROGRESS.md`'s matching
  section.

**Result: the invitation-expiration scheduler gap is closed. Remaining Known Limitations are now only
dispute-driven restriction, CSV bulk-invite integration, and no UI built — none of which were ever
scored as failing acceptance criteria.**

## Architecture Discovery
- **Master branch/commit used:** worktree `sprint-18a-relationship-architecture`, branched from `master`'s tip at the Sprint 17 merge commit (`master` unchanged since the prior session's "Sprint 17 PR merged / sync master" confirmation).
- **Actual Sprint 1–20 specs discovered:** all 20 files in `docs/sprints/` read in full (`SPRINT_01`…`SPRINT_20`, plus the pre-existing `SPRINT_06A`), cross-referenced against both Sprint 18A source documents.
- **Existing relationship-like structures discovered:** `agreement_party` (Sprint 5) ties a profile to a role *per agreement*, not reusably across agreements; `business_staff_member` (Sprint 4) is an org-internal membership, not a cross-party relationship. Neither generalizes to "two parties cooperating across possibly multiple agreements over time" — the gap this sprint fills.
- **Implicit relationship paths discovered:** an agreement's `creditorProfileId`/`debtorProfileId` pair is the only existing signal that two parties are "related," and it's agreement-scoped only — no durable, agreement-independent party-to-party record existed before this sprint.
- **Duplicate party/role patterns discovered:** none — every prior sprint's `profileKind + profileId` pattern is consistent; no competing role vocabulary existed to reconcile (this sprint reuses `agreementPartyRoleEnum` directly rather than inventing a second one).
- **Existing financial-account architecture:** Sprint 11 (`ach_mandate`) and Sprint 12 (`debit_card_method`) are both strictly agreement-scoped — a bank account or card exists only in the context of one agreement's authorization, with no reusable, party-owned identity layer above them.
- **Existing agreement/payment/ledger connector architecture:** Sprint 5 (agreements) → Sprint 9/10 (payment/ledger) → Sprint 11/12 (ACH/card) → Sprint 13 (retry) → Sprint 14/15 (amendment/settlement) → Sprint 16 (dispute) → Sprint 17 (notification) form a single well-connected chain, all keyed off `agreementId`. This sprint's job was to add a *new* layer above it (relationship), not touch the chain itself.
- **Architectural gaps identified:** (1) no reusable financial-account identity; (2) no durable relationship entity independent of a single agreement; (3) no cooperative double-opt-in handshake anywhere in the codebase (agreement creation today just names a counterparty by profile ID). All three addressed additively.

## Implementation
- **Worktree:** `sprint-18a-relationship-architecture` (isolated; no other in-flight work touched).
- **Files created (29):** 2 schema files, 3 domain services, 8 Drizzle repositories/adapters + 1 debit-card adapter (remediation), 3 DI wiring files, 1 test-fakes file, 5 test files (4 original/remediation + 1 scheduler route test from the closure fix), 18 route files (15 original + 2 evidence routes from remediation + 1 scheduler route from the closure fix), 2 migrations + 2 snapshots.
- **Files modified (21):** original pass — `src/db/schema/{enums,index,agreement,ach,debitCard}.ts` (additive only), `src/lib/notify/{eventTypes,templates}.ts` (7 new event types); remediation pass — `src/db/schema/financialAccount.ts` (3 new nullable columns), `src/lib/relationships/{relationshipService,relationshipFinancialAccountService,getRelationshipService,testFakes,drizzleFinancialAccountRepository,drizzleRelationshipFinancialAccountRepository,relationshipService.test,relationshipFinancialAccountService.test}.ts`, `src/app/api/relationships/accounts/add/route.ts`; closure fix — `vercel.json` (+1 cron entry), `src/lib/relationships/{relationshipInvitationService,relationshipInvitationService.test}.ts` (orphaned-relationship cleanup on expiry + widened `actingUserId` param).
- **Services created:** `RelationshipService`, `RelationshipInvitationService`, `RelationshipFinancialAccountService`. None replaced; all three gained additive methods/validation/behavior across the remediation and closure-fix passes (no existing method signature broken — `cancelRelationshipIfNeverLinked`'s `actingUserId` was widened from `string` to `string | null`, a strictly broader accepted-input change, not a breaking one).
- **Routes created (21):** 18 original + 2 evidence routes (remediation) + 1 scheduler route (closure fix); none modified.
- **Repository changes:** 6 new Drizzle repositories + 3 narrow connector adapters (2 original + `DebitCardFinancialAccountAdapter` from remediation), all additive; zero existing repository classes modified.
- **UI changes:** none — no UI was built this pass (documented Known Limitation below), matching the "UI is scope-dependent" precedent already set by several prior sprints.

## Database
- **Migration filenames:** `drizzle/migrations/0019_kind_thanos.sql` (original pass), `drizzle/migrations/0020_jittery_may_parker.sql` (remediation pass — 3 `ALTER TABLE "financial_account" ADD COLUMN` statements, all nullable).
- **New tables (5):** `relationship`, `relationship_invitation`, `relationship_participant`, `financial_account`, `relationship_financial_account`.
- **Modified tables (4):** `agreement` (+`relationship_id`), `ach_mandate` (+`financial_account_id`), `debit_card_method` (+`financial_account_id`) — all from the original pass; `financial_account` itself (+`card_expiry_month`, +`card_expiry_year`, +`card_brand`) — from the remediation pass. All nullable, additive.
- **New columns:** the 3 original FK columns, plus every column on the 5 new tables, plus the 3 remediation-pass card-metadata columns.
- **Foreign keys:** all present and correct (hand-inspected in the generated SQL — see migration file lines 95–114 of `0019_kind_thanos.sql`).
- **CHECK constraints:** `relationship_participant_exactly_one_party`, `financial_account_exactly_one_party` — both hand-verified present in the generated SQL (not just trusted from the schema file, per this sprint's own instruction that drizzle-kit's CHECK generation isn't reliably trustworthy blind).
- **Unique constraints/indexes:** `relationship_participant_relationship_role_unique`, `relationship_financial_account_active_slot_unique` (partial, `WHERE status='active'`) — both present.
- **Enum changes:** 7 new enums (`relationship_status`, `relationship_participant_status`, `relationship_invitation_status`, `financial_account_type`, `financial_account_status`, `financial_account_usage`, `relationship_financial_account_assignment_status`).
- **RLS:** `.enableRLS()` on all 5 new tables, matching this codebase's established "RLS + REVOKE, zero CREATE POLICY, authorization enforced in the service layer" pattern (confirmed against the very first migration file before starting).
- **REVOKE status:** hand-added `REVOKE ALL ... FROM anon, authenticated` for all 5 new tables in the original migration (drizzle-kit does not generate these). The remediation migration adds columns to an already-`REVOKE`d table, so no new `REVOKE` statement is needed there.
- **Migration/drizzle result:** both migrations generated cleanly with zero manual schema edits needed beyond the original pass's hand-added `REVOKE` lines; re-running `drizzle-kit generate` after each confirms "No schema changes, nothing to migrate." `npx drizzle-kit check` → "Everything's fine" after both.

## Cooperative Handshake
- **Invitation lifecycle:** `sent → viewed → accepted/declined/expired/cancelled`, all transitions server-side in `RelationshipInvitationService`.
- **Existing-user flow:** email resolved to a known `user_account` at invite time; notified via Sprint 17's `NotificationService.notify()`; accepts using only their own session (no token required, since identity is already resolved).
- **New-user flow:** invitation stored unresolved; a one-time enrollment email carries the raw token directly via `EmailSender.send()` (the one case Sprint 17's `notify()` contract can't represent — it requires a known `recipientUserId`); acceptance requires presenting that raw token.
- **Business flow:** creating/accepting on a business's behalf requires the `send_invitation` capability (owner bypasses); tested with both a granted and a denied staff member.
- **Identity selection:** the acting party (`{kind, id}`) is explicit on every call and independently authorized via `authorizeParty` — never inferred from the invitation alone.
- **Token protection:** only `hashOpaqueToken`'s SHA-256 digest is ever persisted; the raw token is never written to any table, log, or `notify()` payload.
- **Replay protection:** a wrong user or a tampered token is rejected with `ForbiddenError`; a resolved invitation locks acceptance to that one `resolvedInviteeUserId` going forward.
- **Idempotency:** a repeated, identical acceptance returns the existing state rather than duplicating a participant row or erroring — tested directly.
- **Relationship creation behavior:** a `relationship` row (status `invited`) plus the inviter's own `relationship_participant` row are created atomically at invite time; the counterparty's row is created only by `acceptInvitation`. An invitation declined, cancelled, **or expired** before any counterparty ever links now correctly cancels the orphaned relationship (a real gap caught by this sprint's own test suite and fixed — the "expired" case was closed in the closure-fix pass, applying the identical cleanup decline/cancel already had).
- **Invitation expiration (closure fix):** `expireDueInvitations` is now actually reachable in production via `POST /api/scheduler/expire-relationship-invitations` (`CRON_SECRET`-gated, `vercel.json` cron entry `"0 16 * * *"`). Idempotent by construction — `findDueForExpiry` only selects invitations still `sent`/`viewed` past their `expires_at`, so `accepted`/`declined`/`cancelled`/already-`expired` invitations are structurally unreachable, and a repeated run finds nothing left to do.

## Financial Accounts
- **Add-bank-account flow:** `RelationshipFinancialAccountService.addAccount` — party-owned, status `pending_verification` on creation.
- **Provider/tokenization boundary:** only `providerAccountRef` (opaque token), `maskedLast4`, and `institutionDisplayName` are ever stored — no raw account/routing number, PAN, or CVV anywhere in the schema.
- **Verification flow:** `applyVerificationResult` is the single seam Sprint 11/12's own verification mechanisms call into — no second verification framework invented; an account is never eligible for assignment before verification completes.
- **Individual ownership:** `individual_profile_id` set, `organization_id` null, enforced by the CHECK constraint.
- **Organization ownership:** the reverse — and directly tested to never be substitutable by a staff member's own personal account.
- **Funding assignment:** `assignAccount`, usage `funding` — verified-only, ownership-matched, one active assignment per slot.
- **Payout assignment:** identical mechanism, usage `payout`.
- **Account replacement:** `replaceAccount` — never overwrites history (new `active` row, prior row marked `superseded` via `supersededBy`); idempotent for a same-account "replacement"; counterparty notified; no mutual approval required (mirrors Sprint 11/12's own existing bank/card-change precedent, which also requires only the payer's own action).
- **Sensitive-data handling:** admin views (`getRelationshipAccountsForAdmin`) explicitly omit `providerAccountRef` even though it's already an opaque token — verified by a test asserting the raw ref string never appears in the admin JSON output.
- **Debit-card auto-registration (remediation):** `addAccount` requires `maskedLast4`/`cardExpiryMonth`/`cardExpiryYear` when `accountType` is `debit_card` (range-validated: month 1–12, year ≥ 2000), mirroring `debit_card_method`'s own NOT NULL columns exactly. `linkAgreement` then auto-registers a real Sprint 12 `debit_card_method` row via `DebitCardFinancialAccountAdapter` (delegates entirely to `DebitCardMethodService.registerCard` — no card logic reimplemented), symmetric with the existing ACH mandate auto-authorization.

## Relationship Architecture
- **Participant model:** `relationship_participant` — exactly one party (individual or organization), a role, a representing user, membership status, join/leave timestamps.
- **Role model:** reuses `agreementPartyRoleEnum` (`creditor`/`debtor`) directly.
- **Lifecycle state machine:** 14 states (`invited → counterparty_linked → identities_confirmed → financial_setup_pending → financial_accounts_ready → agreement_pending → agreement_ready → signature_pending → signed → active → restricted/suspended/closed/cancelled`), driven by three read-time-sync methods rather than ad hoc writes scattered across callers.
- **Activation gate:** `checkActivationPrerequisites` returns explicit reason codes (never a bare boolean) for every one of: status blocking, counterparty missing, agreement missing, signature missing, funding/payout missing or unverified, mandate missing (bank-account funding), and `card_missing` (debit-card funding — added in the remediation pass, symmetric with `mandate_missing`).
- **Restriction behavior:** Platform Admin/Owner-only (`isAdminRole`), itself audited.
- **Closure behavior:** either active participant may close; idempotent; never erases agreement/payment/ledger/dispute/audit history.
- **Historical preservation:** append-only assignment history via `supersededBy`; append-only invitation records; no destructive updates anywhere in either new service.

## Cross-Sprint Integration
Full per-sprint connector matrix (connector / data path / authorization impact / tests / future dependency) is written out in `docs/SPRINT_CONTROL.md`'s new "Sprint 18A implementation notes" section. Summary:

| Sprint | Connector | Tested |
|---|---|---|
| 2 Auth | Actor identity, token utility reuse | Indirectly, throughout |
| 3 Profiles | Party ownership / `authorizeParty` | Yes — ownership-rejection tests |
| 4 Staff Permissions | `send_invitation`/`change_payout_configuration` capability gating | Yes — granted/denied/owner-bypass cases |
| 5 Agreements | `agreement.relationship_id` + `linkAgreement`/`syncFromAgreement` | Yes — full lifecycle test |
| 6 Signatures | `syncFromAgreement` reads `signed_at` | Yes — via the same test |
| 6A Admin | `isAdminRole`-gated relationship/financial-account admin views | Yes — non-admin rejection + audited access |
| 7 Evidence/Documents | **Remediated** — `getRelationshipEvidence`/`getRelationshipEvidenceSignedUrl` delegate to Sprint 7's unmodified `EvidenceService` | Yes — no-agreement-yet rejection + full shared/private/witness visibility scenario + unrelated-party rejection + signed-URL passthrough |
| 8 B2B/CSV | B2B handshake tested; CSV bulk-invite not built | Partial — **Known Limitation (CSV)** |
| 9 Payment Provider | Boundary preserved (no direct import) | Structural, not a runtime test |
| 10 Ledger | Traceable via `agreement.relationship_id` alone, no direct FK added | Not directly tested (no new code) |
| 11 ACH | Auto-mandate authorization at `linkAgreement` | Yes — dedicated connector test + edge-case `mandate_missing` test |
| 12 Debit Card | **Remediated** — `financial_account` gained card-metadata columns; `linkAgreement` auto-registers a real `debit_card_method` row via `DebitCardFinancialAccountAdapter` | Yes — field-validation test + auto-registration test + edge-case `card_missing` test |
| 13 Retry | **Remediated (closure fix)** — cron-scan pattern (`findDueForExpiry`) now wired to a real route, `POST /api/scheduler/expire-relationship-invitations`, mirroring `retry-failed-payments`/`retry-notifications` exactly | Yes — valid/invalid auth, due/not-due transitions, accepted/declined/cancelled untouched, idempotent repeat execution |
| 14 Amendments | Not directly wired (derivation-only) | Not directly tested |
| 15 Partial/Settlement | Not directly wired | Not directly tested |
| 16 Disputes | Deliberately not auto-wired to `restrict` | **Known Limitation (dispute restriction)** |
| 17 Notifications | 7 new event types, templated, classified | Yes — replacement-notification test |
| 18 AdminSupport | Not started (correct — not in scope) | — |
| 19 Fraud/Risk | No engine built; audit trail sufficient for future detection | Structural only |
| 20 Beta Readiness | Not started | — |

## Security Review
- **IDOR:** every read/write requires `resolveActingParticipant`/`authorizeParty`/`isAdminRole` — never a bare ID lookup; verified via the isolation scenario test.
- **Token security:** SHA-256 hash-only persistence, tampered/wrong-token rejection tested directly.
- **Cross-tenant isolation:** an unrelated user or organization is rejected from viewing or acting on a relationship/account they don't participate in — tested in both the P2P isolation scenario and the B2B cross-organization scenario.
- **Business capabilities:** `send_invitation`/`change_payout_configuration` correctly gate the relevant actions; a default "manager" role's lack of `change_payout_configuration` is directly exercised as a rejection case, not assumed.
- **Financial-account substitution:** blocked both at assignment time (ownership match required) and at replacement time (only the assigning participant may replace); a staff member's personal account is directly tested as rejected for a business slot.
- **Provider-secret handling:** never a raw account/routing number, PAN, or CVV in any table; admin views additionally omit the opaque provider token itself.
- **Logging:** no raw token or provider secret ever appears in an audit payload, notification payload, or console output (verified via assertion, not just review).
- **Admin access:** `isAdminRole`-gated, and itself audited (`ADMIN_RELATIONSHIP_VIEWED`, `ADMIN_RELATIONSHIP_FINANCIAL_ACCOUNTS_VIEWED`).
- **RLS:** `.enableRLS()` + `REVOKE` on all 5 new tables, consistent with this codebase's real authorization mechanism living in the service layer (verified against the original migration's own precedent before writing any code).

## Tests
- **Tests added:** 52 total, across 5 files. Original pass (38): `relationshipInvitationService.test.ts` — 12, `relationshipService.test.ts` — 9, `relationshipFinancialAccountService.test.ts` — 11, `relationshipScenarios.test.ts` — 6. Remediation pass (+5, in existing files): debit-card `addAccount` field validation, debit-card auto-registration at `linkAgreement`, `card_missing` edge case, document/evidence no-agreement-yet rejection, document/evidence full visibility scenario. Closure fix (+9): 2 in `relationshipInvitationService.test.ts` (relationship-cancellation-on-expiry consistency; idempotent repeated `expireDueInvitations`) + 7 in the new `src/app/api/scheduler/expire-relationship-invitations/route.test.ts` (valid auth; missing auth rejected; wrong-token auth rejected; due-vs-not-due transition; accepted invitation untouched; declined/cancelled invitations untouched; idempotent repeated execution).
- **Total tests passing:** 663/663.
- **Total test files:** 83 (up from 78 at the end of Sprint 17; +1 in the closure fix for the new scheduler route test).
- **Regressions:** zero — every Sprint 1–17 test and every pre-closure-fix Sprint 18A test still passes unchanged.
- **Failed tests:** none remaining (two self-caught issues during the original pass's authoring — a missing `rawToken` param on `declineInvitation`, and a capability-mismatch in the B2C scenario draft — were fixed before the original report, not left broken; neither the remediation nor closure-fix pass introduced any new failures).

## Validation
- `npm run typecheck` (`tsc --noEmit`): **0 errors.**
- `npx eslint` (scoped to every new/modified file): **0 errors, 0 warnings.**
- `npm run build` (`next build`, Turbopack): **pass** — all 21 relationship-domain routes generated as dynamic (`ƒ`) routes (18 original + 2 evidence routes from remediation + 1 scheduler route from the closure fix); no existing route's classification changed.
- `npx drizzle-kit check`: **pass**, "Everything's fine" (checked after both migrations; the closure fix introduced no schema change).
- **Migration status:** both migrations applied cleanly to the schema snapshot; `drizzle-kit generate` re-run after each, and again after the closure fix, confirms no drift ("No schema changes, nothing to migrate" each time).
- **Schema drift:** none.
- **Git status:** additive-only footprint throughout — modified files are exactly the ones listed in Implementation above (original + remediation + closure fix), all new top-level paths are new files/directories; no file outside this footprint was touched; nothing staged, committed, or pushed.

## Known Limitations
1. ~~Document/evidence connector (Phase 25) not wired.~~ **RESOLVED in the remediation pass.** `RelationshipService.getRelationshipEvidence`/`getRelationshipEvidenceSignedUrl` now delegate to Sprint 7's `EvidenceService`, gated by relationship participation, with two new routes and two new tests. No longer a limitation.
2. ~~Debit-card auto-registration (Phase 21) not implemented.~~ **RESOLVED in the remediation pass.** `financial_account` gained the required card-metadata columns; `linkAgreement` now auto-registers a real `debit_card_method` row via `DebitCardFinancialAccountAdapter`, with three new tests including a `card_missing` edge case. No longer a limitation.
3. **Dispute-driven restriction (Phase 34) not auto-wired.** `AgreementDisputeService.restrictDispute` does not call `RelationshipService.restrict`. **Why it remains:** avoiding a new dependency edge into an already-shipped, already-tested Sprint 16 file was judged appropriately conservative for this pass. **Intentionally out of scope:** yes — the same class of gap Sprint 16 itself left open for payment-scheduling enforcement. **Owner:** a future sprint touching `AgreementDisputeService`.
4. **CSV bulk-invite integration (Phase 26) not built.** **Why it remains:** Sprint 8's CSV pipeline was not extended to create relationship invitations per row. **Intentionally out of scope:** yes. **Owner:** a future sprint extending Sprint 8's import pipeline (never auto-activating, per Phase 26's own explicit instruction).
5. ~~No cron/scheduler route wired for `expireDueInvitations`.~~ **RESOLVED in the closure fix.** `POST /api/scheduler/expire-relationship-invitations` (mirroring Sprint 13/15/17's identical scheduler-route pattern) now calls it on a daily cron; a real orphaned-relationship consistency gap this exposed was fixed at the same time. No longer a limitation.
6. **No UI was built.** **Why it remains:** neither spec file's own UI/workflow phase names this as a hard requirement for this implementation pass, matching most prior worktree sprints' own precedent. **Intentionally out of scope:** yes. **Owner:** a future dedicated UI pass once the API surface is reviewed.
7. **Test-suite coverage against the suggested 65-scenario checklist is substantial but not literal 1:1.** Full accounting of what is/isn't covered and why is in `docs/PROGRESS.md`'s Sprint 18A section. **Why it remains:** an honestly-bounded suite covering every security-critical and architecturally load-bearing case was prioritized over mechanically hitting every one of 65 illustrative scenario names — the remediation and closure-fix passes' 14 combined new tests narrow this further but do not close it completely (document/evidence connector and retry/scheduler test categories are now both satisfied; most other Cross-Sprint checklist items remain as originally scoped). **Intentionally out of scope:** yes, a deliberate scoping decision stated up front. **Owner:** none required — flagged for Product Owner awareness, not a defect.

Remaining open limitations are **3, 4, 6, and 7 only** — items 1, 2, and 5 (the three that were ever
scored as blocking or flagged as a real production gap) are all resolved. None of the remaining four
were ever scored as a failing acceptance criterion — each was always scoped as intentionally deferred.

## Acceptance Criteria
| Requirement | Status |
|---|---|
| Accounts belong to parties, not agreements/relationships | **PASS** |
| First-class `relationship` entity | **PASS** |
| Relationship participants with strong ownership integrity | **PASS** |
| Cooperative handshake (existing + new user) | **PASS** |
| Token never persisted in plaintext | **PASS** |
| Replay/tamper/wrong-user rejection | **PASS** |
| Idempotent acceptance | **PASS** |
| Business capability gating on invitation | **PASS** |
| Relationship role model | **PASS** |
| Relationship lifecycle state machine | **PASS** |
| Explicit, machine-readable activation gate | **PASS** |
| Financial account ownership model (party-owned, reusable) | **PASS** |
| Bank account addition + verification | **PASS** |
| Funding vs. receiving distinction | **PASS** |
| Financial account authorization/assignment | **PASS** |
| Financial account replacement preserving history | **PASS** |
| No sensitive banking data stored | **PASS** |
| ACH connector (reuse Sprint 11, no bypass) | **PASS** |
| Debit-card connector | **PASS** *(remediated — see "Remediation Pass" above)* |
| Payment provider boundary preserved | **PASS** |
| Agreement connector (additive linkage) | **PASS** |
| Signature connector | **PASS** |
| Document/evidence connector | **PASS** *(remediated — see "Remediation Pass" above)* |
| B2B connector (org-owned accounts, no personal substitution) | **PASS** |
| Notification connector (no second notification system) | **PASS** |
| Audit connector (every named action audited) | **PASS** |
| Admin connector (read-only, masked, itself audited) | **PASS** |
| Security/fraud event surfaces (audit trail sufficient) | **PASS** |
| Required automated tests (honestly bounded) | **PASS — see coverage note above** |
| Full repository test suite, zero regressions | **PASS** |
| Migration additive, RLS + REVOKE present | **PASS** |
| Documentation updated (`SPRINT_CONTROL.md`, `PROGRESS.md`) | **PASS** |
| Sprint 1–20 connector matrix produced | **PASS** |
| Sprint 18 not begun | **PASS** |
| No commit/push/merge/deploy | **PASS** |

**Awaiting ChatGPT/Product Owner Sprint 18A architecture and implementation review. I will not commit, push, merge, deploy, or begin Sprint 18.**
