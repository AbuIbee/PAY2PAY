# PRSprint 12: Electronic Signatures, Agreement PDFs & Immutable Executed Records

## Trigger

Next PRSprint in the numbered sequence, authorized after PRSprint 11B's merge. Full 37-requirement
specification supplied by the Product Owner (electronic signature authorization, version binding,
UX/consent, transactional signing, idempotency, tamper evidence, executed PDFs, immutability,
storage/RLS security, admin visibility, mobile/accessibility, error handling, and an extensive
security/regression test matrix).

## Targeted audit: what already existed vs. what was actually missing

A substantial, production-grade signature/PDF architecture already existed from "Sprint 6"
(`docs/sprints/SPRINT_06_ElectronicSignatures_PDFRecords.md`, pre-dating the PRSprint numbering):
`signature_event` (full evidence bundle — signer identity/role/authority, consent, auth method,
IP/device/timezone, per-signature terms hash) and `agreement_pdf` (one immutable PDF per fully-signed
version, private Supabase Storage bucket, tamper-evident file hash) tables; `SignatureService`
(step-up MFA + full identity/business verification gate before ever touching the state machine;
business signing-authority checks; short-lived signed-URL retrieval, both-parties-only); a
`pdf-lib`-rendered executed document; and a UI (`AgreementDetail.tsx`) with an explicit "Sign this
agreement" button, live signature status per party, and a "View signed PDF" action. Reading the
actual code (not documentation) found this was substantially complete against the 37-point
specification, with six concrete, provable gaps closed this PRSprint rather than a rebuild:

1. **Signing was not transactionally atomic (requirement #7/#8 — Hard-Stop-adjacent).**
   `AgreementService.signAgreement`'s completing signature made 2–4 independent, non-transactional
   writes (record this role's signature, lock the version, advance the agreement's status twice), and
   `SignatureService` made a *fifth*, entirely separate write (the `signature_event` evidence row)
   only after all of those had already committed. A transient failure between any of those steps —
   the exact category of failure PRSprint 11A found in production — could leave the agreement
   advanced with no evidence row for it, and a retry would then hit "already signed" forever, unable
   to ever complete; two truly concurrent requests could also both pass the pre-write "already
   signed?" check before either write landed. Fixed: a new `SigningApplicationRepository`
   (`agreementService.ts`/`drizzleSigningApplicationRepository.ts`), mirroring PRSprint 11's own
   `AmendmentApplicationRepository` pattern exactly — one hand-written `db.transaction()` that
   re-checks "already signed?" *inside* the transaction (closing the race), records the signature,
   conditionally locks the version and advances the agreement's status twice, and — when evidence is
   supplied — inserts `signature_event`, all as one atomic commit/rollback unit.
   `AgreementService.signAgreement` (Sprint 5's original primitive, still directly unit-tested) is now
   a thin wrapper over a new `signAgreementWithEvidence`, which `SignatureService.sign` calls instead
   of the old two-step (state-machine call + separate evidence insert) sequence — behavior, error
   messages, and every existing audit record are byte-for-byte unchanged.
2. **PDF content gaps against the explicit requirement #12 field list.** The rendered document had no
   generation/effective-date line, no ESIGN/UETA-style electronic-record disclosure, no document/
   execution identifier printed inside the file itself, and a *hardcoded* "No amendment has been made
   to this agreement" claim regardless of whether the version being rendered actually resulted from
   one. Fixed: `generateAgreementPdf` now prints a server-trusted `generatedAt` timestamp, a
   `Document/execution ID` (generated before rendering — see `AgreementPdfRepository.insert`'s
   optional `id` — so it can be included in the document's own content and reused as the row's real
   primary key), an electronic-record disclosure paragraph, and a conditional amendment-reference
   line naming the version this one resulted from and confirming the prior version remains preserved,
   whenever `agreement_version.isOriginal` is false.
3. **No route-level tests existed for the actual production signing/PDF endpoints.** Every other
   sensitive route in this codebase (login, logout, admin/*) has its own `route.test.ts` proving the
   HTTP-layer 401/403/200 boundary; `/api/agreements/sign` and `/api/agreements/pdf` had none — only
   service-layer coverage. Added both, including the mandatory "anonymous signing is prohibited"
   (401), "not a party to the agreement" (403, server-side, not just UI), and a full real-route
   200 signing path.
4. **No admin visibility into agreement version/signature/execution status.** `AdminService`'s own
   doc comment already establishes (correctly, unchanged) that it must never be able to *mutate*
   agreement/signature/PDF data — but nothing gave a Platform Owner/Admin *read-only* visibility into
   an agreement's current version number, whether it's signed, or whether an executed PDF exists,
   without leaving the admin console. Added `AdminAgreementSummary` (version number, signed flag,
   executed-PDF flag) via a new shared, read-only `summarizeAgreementsForAdmin` helper — two batched
   queries against `agreement_version`/`agreement_pdf` directly, never through `AgreementService`/
   `SignatureService` — wired into both the existing user-detail and business-detail admin views.
5. **Idempotency/replay and the mandatory amendment/signature-carry-forward scenario had no dedicated
   tests.** Added both: a same-party double-submit is cleanly rejected with exactly one
   `signature_event` recorded (not a raw DB error), three repeated duplicate submissions never
   advance the agreement past its correct state, and a full cross-service integration test proves a
   version's signature evidence never carries forward to a version an amendment produces — the new
   version starts requiring its own, entirely separate approval, and the original version's evidence,
   hash, and lock remain untouched.
6. **A pre-existing, unrelated test (`b2bWorkflowService.test.ts`) broke under the new atomicity
   change** because it constructed its own `SignatureService` sharing the shared `AgreementService`
   context, but with its own disconnected `signature_event` store the atomic write path never touched
   — a real, if narrow, gap in the earlier `InMemorySigningApplicationRepository` test-fake design.
   Fixed by making that fake's internal evidence array a public field other test contexts can share,
   and updating the one affected test to read from it directly.

No database/schema/migration change was needed anywhere in this PRSprint — every gap above was a
missing atomicity/content/test/visibility capability against tables and columns Sprint 6 already
established.

## Deliberately left as-is (with rationale, not silently skipped)

- **`AmendmentService.signAmendment` (Sprint 14/PRSprint 11) does not require step-up MFA or identity
  verification**, unlike `SignatureService.sign`'s much stricter gate. This is a real inconsistency
  in signing rigor between the original-agreement path and the amendment-approval path, but
  retrofitting MFA/verification onto an already-approved, already-tested PRSprint 11 mechanism is a
  meaningfully different, higher-blast-radius change than this remediation's scope — flagged here as
  a known limitation for a future, dedicated PRSprint rather than attempted inside this one.
  Independently, this does **not** create a signature-carry-forward risk (verified directly by this
  PRSprint's own new test): `agreement_version.creditor_signed_at`/`debtor_signed_at` are version-
  scoped columns, a new version always gets its own row with its own id, and no code path anywhere
  copies or reuses a prior version's `signature_event` rows.
- **Forged client timestamp, signature mutation, signature deletion** (security-test-matrix items):
  confirmed structurally impossible rather than merely untested — the sign request schema has no
  timestamp field at all (the server always computes it), and `SignatureEventRepository` exposes no
  update/delete method anywhere in the codebase.
- **Stale-version / superseded-version signing**: structurally impossible by construction — the sign
  request never accepts a version id from the client; the server always resolves and signs whatever
  `agreement.currentVersionId` currently is, gated by `requireStatus(agreement, "awaiting_signatures")`.
- **Cancelled-agreement signing**: `mutually_canceled` exists only as a status enum value; no code
  path anywhere in this codebase can currently transition an agreement into it, so there is no real
  scenario to exercise yet (reserved for a future sprint).
- **Deeper financial/provider-adjacent PDF fields** (card status, live webhook errors): unchanged from
  PRSprint 11B's own identical finding — no live payment/KYC/card provider exists in this codebase
  yet (sandbox only), so there is nothing real to surface.

## Signature architecture (how signatures bind to versions and authenticated users)

`SignatureService.sign` re-derives the caller's party role and profile from the authenticated
session via `AgreementService.resolvePartyRole`/`getAgreement` (never trusts a client-supplied role);
requires a fresh step-up MFA challenge; requires the signer's own identity (and, for a business
signer, the business profile and — for staff — an explicit authorized-representative flag) to be
fully verified; computes `agreementHashAtSigning = sha256(agreementId, versionNumber, terms)` for
the *exact* version currently presented; and only then calls the new atomic
`signAgreementWithEvidence`, which records the signature and the `signature_event` evidence row
(agreement id, version id, signer user/profile/role, signing authority, consent version, auth
method, IP/device/timezone, the terms hash, and a server-trusted timestamp) as one transaction. A
`signature_event_version_role_unique` DB constraint backstops the transaction's own re-check against
a duplicate. Once both roles have signed, the version is locked (`document_hash`/`signed_at` set,
immutable from that point per Sprint 5/PRSprint 11's existing invariants) and the agreement advances
through its existing state machine.

## Immutability architecture

Signed `agreement_version` rows are never edited in place (unchanged since Sprint 5/PRSprint 11) —
a later change is only ever a brand-new version row via the amendment workflow, requiring its own
fresh mutual approval and (per this PRSprint's own new coverage) its own fresh sign-off, never
inheriting a prior version's evidence. `signature_event` has no update/delete code path at all.
`agreement_pdf` has a unique index on `agreement_version_id` and is generated exactly once per
version (checked-then-generated, never regenerated); its `document_hash` lets the stored bytes be
re-verified against the row at any time.

## PDF architecture

Generated synchronously, once, the moment both signatures land (`SignatureService.generatePdf`),
using the exact version data just locked (never reconstructed from possibly-since-changed live
tables later). Rendered via `pdf-lib` with agreement/version identifiers, a server-trusted generation
timestamp, an embedded execution ID, participants, principal/schedule/frequency/terms, an amendment
reference when applicable, an electronic-record disclosure, and each signature's role/name/timestamp/
auth method. Uploaded to the private (`public = false`) `agreement-pdfs` Supabase Storage bucket
(confirmed live — see Database Verification below); retrieval is always through a freshly issued,
300-second signed URL from `SignatureService.getSignedPdfUrl`, itself gated by the same
either-party-only authorization every other agreement read uses — never a public or predictable URL.

## Tests

- `src/lib/signatures/signatureService.test.ts`: 16 tests (3 new) — idempotency/double-sign
  protection (2) and the amendment signature-carry-forward integration (1).
- `src/lib/agreements/agreementService.test.ts`, `src/lib/amendments/amendmentService.test.ts`: 34
  tests, unchanged, all passing against the new atomic signing path (proves zero behavioral
  regression from the atomicity refactor).
- `src/app/api/agreements/sign/route.test.ts` (new): 5 tests — anonymous rejected (401), malformed
  session rejected (401), invalid body rejected (400), non-party rejected (403, server-side), and a
  full real-route 200 signing path.
- `src/app/api/agreements/pdf/route.test.ts` (new): 2 tests — no session (401), authenticated
  stranger denied (403).
- `src/lib/b2b/b2bWorkflowService.test.ts`: fixed (see gap 6 above), all 6 tests passing.
- Full suite: 952/952 passed (up from 942 — 10 net new, no regressions; +1 file/-0 from a bug found
  and fixed in an existing test's own wiring, not a new gap in production code).

## Security verification (requirement #28)

Cross-user (a real, authenticated non-party rejected — 403, both at the service layer and the new
route-level test), cross-tenant (document-access-isolation test: both parties retrieve their signed
URL, a stranger cannot), replay/duplicate submission (new idempotency tests — cleanly rejected, no
duplicate evidence row, agreement never over-advances), anonymous signing (401, route-level test),
direct API invocation (every test above calls the actual route handler / service method directly,
not through any UI layer). Stale-version/superseded/cancelled-agreement signing, forged client
timestamps, and signature mutation/deletion are addressed under "Deliberately left as-is" above —
confirmed structurally impossible rather than merely untested.

## Authentication/Admin regression results (requirements #31/#32)

Local: full `login-logout-cycle.test.ts` (11), `rate-limit.test.ts` (13), `login/route.test.ts` (5),
`logout/route.test.ts` (8), `AppNav.test.tsx` (3), and the full `adminService.test.ts`/admin route
suites (93) all re-run and passing unchanged.

Live production (`https://paid2you.com`, throwaway test accounts, this PRSprint):
- New-user signup → 201; login → 200; `/api/auth/me` while authenticated → 200; logout → 200;
  `/api/auth/me` after logout → 401 (denied, as required).
- Existing-pattern login → logout → **login again** → 200 (the PRSprint 11A mandatory regression
  scenario, re-verified live).
- `/api/admin/whoami` for the new ordinary member → `{"platformRole":"member","isAdmin":false}`;
  `GET /api/admin/overview` for that same member → 403 (denied, as required).
- `/login`, `/admin`, `/dashboard` → 200. `POST /api/agreements/sign` and
  `GET /api/agreements/pdf` with no session → 401 each, matching the new route tests exactly.
- Platform-Owner-positive `/admin` access was not re-tested live (no owner credentials handled by
  this session, per this project's own credential-handling rules) — verified instead by the full,
  passing local admin-authorization test suite, and by this PRSprint changing zero authorization
  logic on that path (only adding new business-admin sub-features and fixing a nav label).

## End-to-end signature test (requirement #33)

Exercised via `signatureService.test.ts`'s existing "both parties signing transitions the agreement
and generates the PDF exactly once" test plus this PRSprint's own new tests: agreement created and
reaches `awaiting_signatures`; creditor signs → status stays `awaiting_signatures` (partially
signed), no PDF yet; debtor signs the same version → status becomes `first_payment_pending`, PDF
generated exactly once, hash verified against stored bytes; both parties retrieve a signed URL, a
stranger cannot (403, both service- and route-level); the executed version's terms/hash remain
unchanged and no further counter-proposal is possible. The one sub-step not exercised through the
*real* invitation-claiming flow specifically (PRSprint 10's `AgreementInvitationService`) — both
parties are seeded directly as already-registered profiles instead — is unchanged from Sprint 6's
original test design; PRSprint 10's own test suite already separately proves invitation-claiming
itself, and PRSprint 12's own new route-level test additionally confirms *anonymous* signing is
impossible regardless of how a party arrived at the agreement.

## Amendment/signature test (requirement #34)

New test in `signatureService.test.ts`: version 1 fully signed (2 signature_event rows, both tied to
version 1's id) → a debtor-proposed amendment is accepted and mutually signed through
`AmendmentService` → version 2 is created with its own id → version 1's own signature_event rows are
unchanged (still exactly 2, still `agreementVersionId = version 1`) → **zero** signature_event rows
exist for version 2 (its "signed" state came from the amendment's own separate approval, never
copied or inherited) → version 1 remains retrievable with its original `signedAt`/`documentHash`
unchanged.

## Database verification (requirement #29)

Verified against the live linked Supabase project (`lmpicrmmixpvkwwhcxbh`) via `supabase migration
list --linked` and `supabase db push --linked --dry-run` (not just confirming migration files exist
locally):

- `20260811130600_sprint6_signatures_pdf.sql` (creates `signature_event`, `agreement_pdf`) — **applied**
  (local timestamp == remote timestamp).
- `20260811131200_storage_buckets.sql` (creates the private `agreement-pdfs`/`agreement-evidence`
  buckets) — **applied**.
- PRSprint 12 itself required **zero new migrations** — confirmed by the dry-run push showing no
  PRSprint-12-authored file pending.

**Separately discovered, out of this PRSprint's own scope but too significant to omit**: the same
dry-run push shows three *earlier* PRSprints' migrations are **not applied** to this live project,
despite their tracker rows recording "Supabase: PASS":
`20260815091000_prsprint02_audit_event_rls_gap_fix.sql`,
`20260815092000_prsprint03_integrity_hardening.sql`, and
`20260816090000_prsprint05_rate_limit_bucket.sql`. The last of these creates `rate_limit_bucket` —
the exact table PRSprint 11A's live diagnosis found failing in production, whose underlying Postgres-
level cause that PRSprint's own report left as an explicitly unresolved "known limitation." A missing
table is fully consistent with the "Failed query" error PRSprint 11A captured, and would explain it
more completely than that report could confirm at the time. This PRSprint did **not** run
`supabase db push` to apply them — doing so is an irreversible, cross-PRSprint production change well
outside "remain inside PRSprint 12" (requirement #37), and is called out explicitly for the Product
Owner's own decision rather than acted on unilaterally. See Remaining Issues below.

## Production deployment verification (requirement #30)

Build: `next build` succeeded locally with every new route/page present, no errors. Live
`https://paid2you.com`: `/login`, `/admin`, `/dashboard` all 200; `/api/health` 200 (still reports
`"environment":"development"`, the same pre-existing, unrelated anomaly PRSprint 11A already flagged
and left open); full signup → login → authenticated-read → logout → denied-after-logout →
login-again cycle verified live with a throwaway account; ordinary-member admin denial verified live;
new `/api/agreements/sign` and `/api/agreements/pdf` both correctly return 401 with no session, live.

## CI / quality gate (requirement #35)

- Typecheck (`tsc --noEmit`): clean.
- Lint (targeted, every changed/new file): clean.
- Full test suite: 952/952 passed.
- Production build: succeeded.
- GitHub Actions CI on the PR: reported in the Git Information section below once opened.

## Remaining issues (not concealed)

1. **Three earlier PRSprints' migrations (02, 03, 05) are not applied to the live production
   Supabase database**, despite being recorded as "Supabase: PASS." This almost certainly explains
   PRSprint 11A's own previously-unresolved "exact Postgres-level cause" question for the
   `rate_limit_bucket` failure. Recommend a dedicated remediation pass (verify exactly what each of
   the three migrations would change against current live data before applying, then apply via
   `supabase db push --linked` with the Product Owner's explicit authorization, since this is an
   irreversible production database change).
2. **`AmendmentService.signAmendment` does not require step-up MFA/identity verification**, unlike
   `SignatureService.sign`. Not a signature-carry-forward risk (verified), but a real rigor gap
   between the two signing paths — recommend closing it in a future, dedicated PRSprint rather than
   as an unplanned addition to this one.
3. `GET /api/health` still reports `"environment":"development"` in production (unset `APP_ENV`) —
   unchanged from PRSprint 11A's own still-open finding, not addressed by this PRSprint.

## Acceptance criteria

- Signing authorization, version binding, transactional atomicity, and idempotency all verified with
  new, passing tests.
- Immutability of executed versions/evidence confirmed unchanged from PRSprint 11's own guarantees.
- Executed PDF generation, storage, and retrieval verified end-to-end, locally and live.
- Full required regression/security/amendment-interaction test matrix passing.
- Zero regressions in authentication, session handling, or admin authorization — verified by the full
  local suite and live production checks.
- Live Supabase and Vercel state verified directly, not assumed from local files.
