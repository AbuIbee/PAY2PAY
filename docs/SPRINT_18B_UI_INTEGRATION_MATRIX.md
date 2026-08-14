# Sprint 18B — UI/Backend Integration Matrix

Built per `docs/sprints/SPRINT_18B_CLAUDE_FULL_UI_INTEGRATION_PROMPT.md` Phase 1. Verified against
the actual repository (schema files under `src/db/schema/*.ts`, all 155 route files under
`src/app/api/**/route.ts`, service directories under `src/lib/*`, and the current ~15 pages / ~20
components under `src/app` and `src/components`) rather than inferred from sprint titles alone.
Sprint spec text is drawn from `docs/sprints/SPRINT_0{1..9}*.md`, `SPRINT_1{0..9}*.md`,
`SPRINT_20*.md`, the Sprint 18A files, and `docs/SPRINT_REQUIREMENTS_MATRIX.md`.

## Current UI baseline (ground truth, before Sprint 18B)

Pages (`src/app/**/page.tsx`, non-API): `page.tsx` (marketing home), `signup`, `login`,
`forgot-password`, `reset-password`, `verify-email`, `account`, `dashboard`, `agreements`,
`agreements/detail`, `admin`, `admin/users`, `admin/users/detail`, `support` (static placeholder —
**no real support-case functionality**, see Sprint 18 section), `privacy`, `terms`, `accessibility`.

Components: `Dashboard`/`AccountDashboard` (real data via `/api/dashboard/personal` and
`/api/dashboard/business`, but minimal — totals/counts only, no action cards, no deep links, no
"what requires action" surface), `ProfileSwitcher`, `BusinessProfileForm`, `LoginForm`,
`SignupForm`, `ForgotPasswordForm`, `ResetPasswordForm`, `VerifyEmailStatus`,
`AgreementsList`/`AgreementDetail`/`AgreementTermsFields`, `AdminDashboard`/`AdminUsers`/
`AdminUserDetail`/`AdminNavLink`, `MobileNavToggle`, `EarlyAccessForm`, `LegalPlaceholder`.

**155 API routes exist across every sprint's backend. Real UI exists for: auth, basic
profile/org switching, a minimal dashboard, agreement list/detail, and Sprint 6A admin
user-management only.** Every other domain (Sprints 5's schedule/signature sub-flows, 6, 7, 8, 9,
10, 11, 12, 13, 14, 15, 16, 17, 18, 18A) has **zero** dedicated UI today. This is the scope Sprint
18B exists to close.

Design-system baseline: no component library — hand-rolled inline styles and a handful of shared
CSS classes (`form-status`, `early-access-form`, `hero__actions`). No shared money/date/status
formatter exists anywhere in `src/components` or `src/lib`.

---

## Sprint 1 — Public Preview / Vercel Readiness

- **Backend capabilities:** early-access lead capture, deployment readiness (no user-facing app
  functionality).
- **APIs/services:** `src/app/api/early-access/route.ts`, `src/lib/early-access/*`.
- **Tables:** `early_access_lead` (`marketing.ts`).
- **Roles:** anonymous visitor only.
- **Business capabilities:** none.
- **Notifications:** none.
- **Audit effects:** none.
- **Current UI coverage:** Complete — `page.tsx` (marketing home) + `EarlyAccessForm.tsx`, tested
  (`EarlyAccessForm.test.tsx`, `page.test.tsx`).
- **Missing/broken/fake UI:** none.
- **Gaps:** none either direction.
- **Pages/components needed:** none new.
- **Sprint 18B modifies:** No — pre-auth marketing surface is out of scope for the authenticated
  product shell.

## Sprint 2 — Authentication

- **Backend capabilities:** signup, email verification, login/logout, password reset, session
  persistence/revocation, account-disabled state, MFA (TOTP + SMS) enrollment/challenge,
  `requireStepUp(user, action)` step-up primitive.
- **APIs/services:** `src/app/api/auth/{signup,login,logout,me,verify-email,resend-verification,
  password-reset/request,password-reset/confirm,mfa/totp/enroll,mfa/totp/confirm,mfa/sms/enroll,
  mfa/sms/confirm,mfa/step-up/initiate,mfa/step-up/verify}/route.ts`; `src/lib/auth/*`.
- **Tables:** `user_account`, `email_verification_token`, `password_reset_token`, `mfa_credential`,
  `mfa_challenge`, `step_up_verification`, `device_session`.
- **Roles:** any authenticated user.
- **Business capabilities:** n/a (platform-level, not per-business).
- **Notifications:** `security_event` (critical).
- **Audit effects:** login/logout, MFA enroll/challenge, step-up attempts.
- **Current UI coverage:** signup/login/forgot-password/reset-password/verify-email pages exist and
  are real (call the actual endpoints). **MFA enrollment/challenge/recovery UI does not exist.**
  **Step-up challenge UI does not exist** — nothing in the current UI ever calls
  `/api/auth/mfa/step-up/*`. **Device/session management UI does not exist** (no page lists
  `device_session` rows or offers revocation). Session-expiration UX is not handled (no interceptor
  redirects a stale session to login with a clear message).
- **Broken/incomplete:** none of the existing pages are broken, but the auth surface is
  incomplete relative to spec (MFA/step-up/session-mgmt missing entirely).
- **Fake/mock UI:** none.
- **Backend-without-UI gaps:** MFA TOTP/SMS enroll+confirm, step-up initiate+verify, device-session
  list (no dedicated list endpoint exists yet — see below).
- **UI-without-backend gaps:** none.
- **Pages/components needed:** `/account/security` (MFA enrollment, recovery codes, session list);
  a reusable `<StepUpChallenge>` modal/drawer invoked generically whenever any mutating fetch
  returns the step-up-required error shape, so "action → step-up required → challenge → success →
  retry original action" works uniformly across every sensitive action (sign, permission change,
  settlement approval) without each feature re-implementing it.
- **User actions:** enroll TOTP, enroll SMS, confirm code, complete step-up challenge, view/revoke
  device sessions, log out of one/all devices.
- **States:** loading, invalid/expired reset token, expired verification link, session-expired
  redirect, step-up failure (retry), MFA enrollment error.
- **Responsive/a11y:** forms need labeled inputs, visible focus, described errors (existing forms
  mostly satisfy this — audit in Phase-10 route audit).
- **Tests required:** MFA enroll/confirm flow, step-up challenge-then-retry flow, session list/revoke.
- **Sprint 18B modifies:** Yes — adds MFA/step-up/device-session UI and the shared `<StepUpChallenge>`
  primitive every later sensitive-action flow (signing, settlement, restriction appeal, etc.) reuses.

## Sprint 3 — Personal & Business Profiles

- **Backend capabilities:** personal profile, multiple business profiles, identity-verification
  state machine (`UNVERIFIED → BASIC → FULL_PENDING → FULL_VERIFIED/FULL_REJECTED`),
  `isFullyVerified(profile)` gate, pricing/account-plan model, profile switcher/active-profile.
- **APIs/services:** `src/app/api/profiles/{route,active,business}.ts`; `src/lib/profiles/*`,
  `src/lib/pricing/*`.
- **Tables:** `personal_profile`, `business_profile`, `identity_verification_record`,
  `pricing_plan`, `subscription`.
- **Roles:** any authenticated user (personal); business owner (business profile creation).
- **Notifications:** none dedicated (verification-status change is not in the 25-event list — a
  UI-without-backend gap if the spec's silent-status-change concern is taken literally; flagged, not
  fixed, since adding a notification type expands backend scope).
- **Audit effects:** profile creation, active-profile switch, verification-status changes.
- **Current UI coverage:** `ProfileSwitcher` (switch only) + `BusinessProfileForm` (create only).
  **No personal-profile edit page. No verification-status display anywhere** (tier, pending/
  rejected reason). **No pricing/plan display anywhere.**
- **Fake/mock UI:** none (what exists is real, just partial).
- **Backend-without-UI gaps:** verification tier/status display + manual-verification-path entry
  (where the audited mock path is user-facing), pricing-plan display, business-profile edit.
- **Pages/components needed:** `/account` (extend existing page) profile-edit section;
  `/account/verification` (tier badge, pending/rejected reason, next-step CTA);
  `/account/billing` or similar for pricing/plan display (read-only unless Sprint 3/9 already
  exposes a self-serve plan-change endpoint — verify before adding any control).
- **User actions:** edit personal profile fields, view verification status, view current
  plan/pricing tier.
- **States:** verification pending/rejected reason, loading, save-error.
- **Tests required:** verification-status badge mapping, profile edit save/error.
- **Sprint 18B modifies:** Yes — profile edit + verification-status + pricing display are net-new
  pages within existing backend scope.

## Sprint 4 — Business Staff / Permissions

- **Backend capabilities:** roles (owner/admin, manager, receivables, accountant/viewer, custom),
  13-capability model (`CAPABILITIES` in `src/lib/staff/capabilities.ts`), invitation/acceptance/
  removal, custom roles, approval thresholds/dual-approval, step-up-gated permission changes.
- **APIs/services:** `src/app/api/staff/{route,invite,accept-invitation,remove,role,
  custom-roles,custom-roles/update,approval-policy,approval-requests,approval-requests/decide}
  /route.ts`; `src/lib/staff/*`.
- **Tables:** `custom_role`, `business_staff_member`, `business_staff_invitation`,
  `business_approval_policy`, `staff_approval_request`.
- **Roles:** owner, manager, receivables_staff, accountant_viewer, custom.
- **Business capabilities:** `create_agreement`, `send_invitation`, `approve_agreement`,
  `propose_amendment`, `approve_hardship`, `approve_partial_payment`, `approve_settlement`,
  `forgive_principal`, `export_records`, `view_reports`, `manage_staff`,
  `change_payout_configuration`, `approve_high_value_action`.
- **Notifications:** `staff_permissions` (critical).
- **Audit effects:** every staff action per spec ("Audit every staff action").
- **Current UI coverage:** **None.** No staff list, no invite form, no role/capability display, no
  approval-request queue anywhere in the current UI.
- **Backend-without-UI gaps:** the entire domain — staff list/invite/remove, custom-role editor,
  approval-policy configuration, approval-request review queue.
- **Pages/components needed:** `/organization/staff` (list, invite, role/capability labels per the
  translation table below, active/inactive), `/organization/staff/roles` (custom role editor),
  `/organization/approvals` (pending approval-request queue with approve/reject + step-up for
  high-risk changes).
- **Capability → label translation (centralized, reused wherever capabilities are shown):**
  `create_agreement`→"Create agreements", `send_invitation`→"Invite counterparties",
  `approve_agreement`→"Approve agreements", `propose_amendment`→"Propose amendments",
  `approve_hardship`→"Approve hardship requests", `approve_partial_payment`→"Approve partial
  payments", `approve_settlement`→"Approve settlements", `forgive_principal`→"Forgive principal",
  `export_records`→"Export records", `view_reports`→"View reports", `manage_staff`→"Manage staff",
  `change_payout_configuration`→"Manage payout accounts", `approve_high_value_action`→"Approve
  high-value actions".
- **User actions:** invite staff, accept invitation, remove staff, edit custom role, set
  thresholds, approve/reject pending approval request.
- **States:** invitation pending/expired, self-promotion blocked, step-up required before
  threshold/role change, empty staff list.
- **Tests required:** capability-label mapping, permission-aware action visibility (a viewer must
  not see manage buttons), approval-request review.
- **Sprint 18B modifies:** Yes — entire organization staff surface is net-new.

## Sprint 5 — Agreement Engine

- **Backend capabilities:** full agreement lifecycle/state machine (13 states), schedule
  calculation, immutable versioning, debtor acknowledgment/creditor accept-reject-counter.
- **APIs/services:** `src/app/api/agreements/{route,detail,submit,decide,acknowledge,sign}
  /route.ts`; `src/lib/agreements/*`.
- **Tables:** `agreement`, `agreement_version`, `agreement_party`, `installment_schedule_item`.
- **Roles:** creditor, debtor (either may initiate a draft).
- **Business capabilities:** `create_agreement`, `approve_agreement`.
- **Notifications:** `agreement_invitation`, `agreement_signed`.
- **Audit effects:** state transitions, version creation.
- **Current UI coverage:** `AgreementsList` + `AgreementDetail` exist and are real (list/detail,
  parties, status). **No creation wizard** (spec explicitly asked for "functional UI" in Sprint 5
  itself, deferring only "visual workflow" refinement to Cursor — a creation flow is not optional
  polish). **No debtor-acknowledgment / creditor-accept-reject-counter UI** — `decide` and
  `acknowledge` endpoints exist with no UI caller found in `src/components`.
  **No version-history view.**
- **Backend-without-UI gaps:** creation wizard, acknowledge/decide actions, version history.
- **Pages/components needed:** `/agreements/new` (Parties → Amount/obligation → Schedule → Terms
  review → Submit wizard per the 18B prompt's own "Agreement creation wizard" section, with
  duplicate-submit protection), acknowledge/decide action buttons on `agreements/detail`, a
  version-history panel there too.
- **User actions:** create draft, debtor acknowledge, creditor accept/reject/counter.
- **States:** duplicate-submit guard, invalid schedule input, awaiting-counterparty states shown
  per the 13-state enum (mapped to plain language, not raw enum strings).
- **Tests required:** creation-wizard happy path, acknowledge/decide, status-label mapping for all
  13 states.
- **Sprint 18B modifies:** Yes — creation wizard and decision actions are net-new; list/detail are
  extended, not replaced.

## Sprint 6 — Electronic Signatures / PDF Records

- **Backend capabilities:** signature capture (identity, role, timestamp, IP, device, consent,
  agreement hash), step-up-gated + `isFullyVerified`-gated signing, immutable PDF generation with
  private-bucket signed-URL access.
- **APIs/services:** `src/app/api/agreements/{sign,pdf}/route.ts`; `src/lib/signatures/*`,
  `src/lib/documents/*`.
- **Tables:** `signature_event`, `agreement_pdf`.
- **Roles:** signer (creditor/debtor/authorized business signer).
- **Notifications:** `agreement_signed`.
- **Audit effects:** signature events (already fully captured per schema).
- **Current UI coverage:** **None.** No signing UI, no PDF viewer/download link anywhere.
- **Backend-without-UI gaps:** the entire signing flow (consent text, step-up challenge, signature
  capture, completion confirmation) and PDF access.
- **Pages/components needed:** `/agreements/detail` signature panel (per-party status, consent
  text, "Sign" action that runs step-up → `isFullyVerified` check → capture, using the shared
  `<StepUpChallenge>` from Sprint 2), PDF download/view action using the existing signed-URL route.
- **User actions:** review consent text, complete step-up, sign, view/download PDF.
- **States:** blocked-not-verified (clear non-punitive message + link to verification), blocked-
  step-up-failed, signing-in-progress, already-signed (must not look editable, per spec).
- **Tests required:** signing gate (blocked when unverified / step-up fails), PDF link renders only
  for authorized parties.
- **Sprint 18B modifies:** Yes — entire signing UI net-new.

## Sprint 7 — Evidence / Documents / Witnesses

- **Backend capabilities:** evidence upload/metadata/shared-private classification/dispute-flag/
  withdrawal, secure signed-URL access, witness model (max 2, isolated from bank/ID docs).
- **APIs/services:** `src/app/api/agreements/{evidence,evidence/signed-url,evidence/withdraw,
  evidence/dispute-flag,witnesses,witnesses/attest,witnesses/view}/route.ts`; `src/lib/evidence/*`.
- **Tables:** `evidence_document`, `agreement_witness`.
- **Roles:** agreement party (upload), witness (attest/view, isolated permissions).
- **Notifications:** none dedicated.
- **Audit effects:** upload, withdrawal, dispute-flag, witness attestation.
- **Current UI coverage:** **None.**
- **Backend-without-UI gaps:** evidence upload/list (with the "Added after agreement signing" label
  for post-signature items), witness invite/attest/view.
- **Pages/components needed:** `agreements/detail` evidence panel (categorized list, upload,
  shared/private + dispute-flag badges, post-signing label), witness panel (invite up to 2, status,
  attest action for the witness's own restricted view).
- **User actions:** upload evidence, withdraw evidence, flag for dispute, invite witness, witness
  attests.
- **States:** upload validation error (file type/size), empty evidence list, witness-limit-reached.
- **Tests required:** post-signing label rendering, witness view isolation (no bank/ID doc access).
- **Sprint 18B modifies:** Yes — net-new panel within `agreements/detail`.

## Sprint 8 — B2B Workflows / CSV Imports

- **Backend capabilities:** B2B agreement flow with signer-authority tracking, business dashboard
  (AR/AP/active/upcoming/past-due/settlements/disputes), CSV import (upload → validate → preview →
  duplicate-check → error-report → create-drafts, never bulk-activate).
- **APIs/services:** `src/app/api/b2b/{route,references,dashboard}.ts`,
  `src/app/api/csv-import/{upload,validate,preview,create-drafts}/route.ts`; `src/lib/b2b/*`,
  `src/lib/csvImport/*`.
- **Tables:** `agreement_reference`, `csv_import_batch`, `csv_import_row`.
- **Roles:** authorized business signer/staff.
- **Business capabilities:** `create_agreement`, `export_records`.
- **Current UI coverage:** `BusinessDashboardData` is fetched by `Dashboard.tsx` but only renders
  receivables/payables/agreement-count/customer-count — **not** the full AR/AP/active/upcoming/
  past-due/settlements/disputes breakdown the spec requires, and explicitly shows "Staff — coming
  in a later phase" / "Reports — coming in a later phase" as placeholder text (this is the one
  instance of genuinely labeled-as-future placeholder copy in the current UI). **CSV import has no
  UI at all.**
- **Fake/mock UI:** the two "coming in a later phase" lines in `Dashboard.tsx` — honest placeholders,
  not fake data, but block-worthy since staff UI ships in this sprint (Sprint 4 section above).
- **Backend-without-UI gaps:** full business dashboard breakdown, entire CSV import flow.
- **Pages/components needed:** expand business dashboard view (or a dedicated
  `/organization/dashboard`) with the seven required sections; `/organization/import` (CSV
  upload → validate → preview → duplicate/error report → create-drafts stepper, explicit "each
  draft still requires individual debtor acknowledgment" messaging).
- **User actions:** upload CSV, review validation errors, create drafts from preview.
- **States:** per-row validation errors, duplicate warnings, partial-success reporting.
- **Tests required:** CSV stepper state transitions, no-bulk-activation assertion in UI copy/behavior.
- **Sprint 18B modifies:** Yes — replaces the two placeholder lines with real UI, adds CSV import UI.

## Sprint 9 — Payment Provider Abstraction / Sandbox

- **Backend capabilities:** provider-independent payment interface (sandbox only), webhook
  signature/replay/idempotency handling, KYC/KYB provider integration wired to Sprint 3's
  verification state machine.
- **APIs/services:** `src/app/api/payments/{create,detail,cancel,refund,webhook}/route.ts`,
  `src/app/api/kyc/{submit,webhook}/route.ts`; `src/lib/payments/*`, `src/lib/kyc/*`.
- **Tables:** `payment_attempt`, `payment_webhook_event`, `kyc_webhook_event`.
- **Notifications:** `payment_scheduled`, `payment_processing`, `payment_cleared`, `payment_failed`.
- **Current UI coverage:** **None dedicated** — no unified payment list/detail exists yet (built
  in this phase per the "Payments / Sprints 9–12" prompt section, see below). The KYC submission
  flow (government-ID/selfie/liveness) has no UI — `isFullyVerified` currently can only be reached
  through whatever manual/audited path Sprint 3 built server-side.
- **Backend-without-UI gaps:** unified payment history/detail (see combined Sprint 9–12 build
  below), KYC submission flow, "no UI should claim sandbox transactions are real" — this constraint
  applies to every payment-status label the new UI introduces.
- **Sprint 18B modifies:** Yes, as part of the combined Payments UI (see Sprint 11/12 sections —
  built once, shared across 9–12 since they share `payment_attempt`).

## Sprint 10 — Internal Financial Ledger

- **Backend capabilities:** double-entry ledger, reconciliation.
- **APIs/services:** `src/app/api/admin/ledger/{adjustment,agreement,reconcile,exceptions,
  exceptions/resolve}/route.ts`; `src/lib/ledger/*`.
- **Tables:** `ledger_account`, `ledger_journal_entry`, `ledger_posting`, `reconciliation_exception`.
- **Roles:** internal ops (owner-only for adjustments, per `LedgerAdminService.postAdjustment`).
- **Current UI coverage:** **None.** This is an internal/admin-facing domain — normal users never
  see raw ledger internals directly (spec: "Never expose... ledger posting internals" to normal
  users), so the required UI is admin-only.
- **Backend-without-UI gaps:** admin reconciliation-exception queue, ledger adjustment tool
  (owner-only, must be behind step-up + confirmation given it moves money-adjacent records).
- **Pages/components needed:** `/admin/ledger` (reconciliation exceptions list + resolve action,
  owner-only adjustment form with confirmation dialog).
- **User actions (admin/owner only):** review reconciliation exception, resolve, post manual
  ledger adjustment.
- **Sprint 18B modifies:** Yes — admin-only ledger page, folded into the Sprint 18/6A admin surface
  build (see below) since it shares the same admin shell/nav.

## Sprint 11 — ACH Sandbox

- **Backend capabilities:** ACH lifecycle (SCHEDULED→SUBMITTED→PROCESSING→CLEARED→PAYOUT_PENDING→
  PAID_OUT, or FAILED/RETURNED/REVERSED/DISPUTED), mandate/authorization, revocation, bank-change
  hooks.
- **APIs/services:** `src/app/api/ach/{mandate,mandate/revoke,mandate/bank-change,
  payments/manual,payments/schedule,payments/submit}/route.ts`; `src/lib/ach/*`.
- **Tables:** `ach_mandate` (+ `payment_attempt`).
- **Notifications:** `bank_change` (critical), `authorization_revoked` (critical).
- **Current UI coverage:** **None.**
- **Sprint 18B modifies:** Yes — folded into the combined Payments + Financial Accounts UI (Phase
  5/7 of this sprint): ACH status chips (verification pending/verified/mandate required/mandate
  active/unavailable) live in the Payment Methods page (financial-account level) and the Payment
  Detail page (per-attempt level).

## Sprint 12 — Debit Card Sandbox

- **Backend capabilities:** tokenized card payments, decline/expired/replaced-card handling,
  ACH-vs-card fee-reallocation rule.
- **APIs/services:** `src/app/api/debit-card/{register,replace,payments/manual,payments/schedule,
  payments/submit}/route.ts`; `src/lib/debitCard/*`.
- **Tables:** `debit_card_method` (+ `payment_attempt`).
- **Notifications:** `card_change` (critical).
- **Current UI coverage:** **None.**
- **Sprint 18B modifies:** Yes — folded into Financial Accounts UI (add card, masked display,
  brand/expiry, fee-reallocation disclosure when switching methods).

### Combined Sprints 9–12 deliverable: unified Payments UI + Financial Accounts UI
- **Pages/components needed:** `/payments` (unified history: amount, date, status, counterparty,
  agreement, installment, method, attempts, retry/dispute state), `/payments/detail/[id]`;
  `/payment-methods` (Bank Accounts + Debit Cards, verification status, masked last 4, active/
  inactive, funding/payout eligibility), `/payment-methods/add-bank`, `/payment-methods/add-card`.
- **User actions:** add/verify bank account, add/replace card, view payment detail, retry manual
  payment where permitted, revoke ACH authorization.
- **States:** pending verification, verified, failed verification, provider error, duplicate
  account, decline, expired card, processing spinner, plain-language processor-error mapping (never
  raw processor errors, per spec).
- **Tests required:** money formatting, financial-account card rendering, ACH/card status mapping,
  duplicate-submit protection on payment creation.

## Sprint 13 — Failed Payments / Retry Workflow

- **Backend capabilities:** failure marking, dual notification, one configurable retry (~3 business
  days), manual-payment cancel-retry, reschedule request/approval.
- **APIs/services:** `src/app/api/installments/reschedule/{request,decide}/route.ts`,
  `src/app/api/scheduler/retry-failed-payments/route.ts`; `src/lib/failedPayments/*`.
- **Tables:** `reschedule_request` (+ `payment_attempt`).
- **Notifications:** `payment_failed` (critical).
- **Current UI coverage:** **None.**
- **Pages/components needed:** failed-payment state card on `/payments/detail/[id]` (safe failure
  category, scheduled-retry date, manual-pay CTA), `/payments/reschedule` request form (debtor) +
  approve/reject view (creditor) reusing the amendment-style diff pattern.
- **User actions:** manual payment after failure, request reschedule, approve/reject reschedule.
- **States:** retry-scheduled countdown, manual-pay-cancels-retry confirmation, no-third-retry
  messaging.
- **Sprint 18B modifies:** Yes — net-new, part of combined Payments UI build.

## Sprint 14 — Amendments / Hardship

- **Backend capabilities:** borrower-proposed amendment (new date/pause/reduced installment/
  revised schedule), creditor accept/reject/counter, immutable versioning.
- **APIs/services:** `src/app/api/agreements/amendments/{propose,decide,sign,withdraw}/route.ts`;
  `src/lib/amendments/*`.
- **Tables:** `amendment`.
- **Notifications:** `amendment` (non-critical, per eventTypes.ts rationale — requires active
  accept/counter/sign anyway).
- **Current UI coverage:** **None.**
- **Pages/components needed:** `/agreements/detail` amendment panel (current-vs-proposed diff,
  propose/accept/reject/counter actions, version/history list). "Never overwrite original terms" —
  diff view must always show both.
- **Sprint 18B modifies:** Yes.

## Sprint 15 — Partial Payments / Settlement

- **Backend capabilities:** partial-payment propose/accept/reject/counter (remainder not auto-
  forgiven), settlement (pre-balance/settlement-amount/forgiven-amount/deadline/failed-settlement
  consequence), step-up-gated settlement approval.
- **APIs/services:** `src/app/api/agreements/{partial-payments/*,settlements/*}/route.ts`;
  `src/lib/partialPayments/*`, `src/lib/settlements/*`.
- **Tables:** `partial_payment_request`, `settlement_proposal`, `settlement_payment`.
- **Notifications:** `partial_payment` (non-critical), `settlement` (critical).
- **Current UI coverage:** **None.**
- **Pages/components needed:** `/agreements/detail` partial-payment panel; settlement panel with
  the spec's own **hard rule: "Accepted" must never visually equal "Paid"/"Completed"** — distinct
  status chips for proposed/accepted/payment-required/pending-payment/completed/failed/expired/
  rejected/cancelled, forgiven-amount shown only after `completed`. Settlement acceptance action
  must run through `<StepUpChallenge>`.
- **Tests required:** settlement status-chip distinctness (accepted ≠ completed), step-up gate on
  accept.
- **Sprint 18B modifies:** Yes.

## Sprint 16 — Disputes

- **Backend capabilities:** two distinct systems — agreement disputes (explanation/category/
  evidence/response) and payment disputes (preserve mandate/signature/identity/IP evidence,
  processor adjudicates).
- **APIs/services:** `src/app/api/agreements/disputes/{open,respond,close,export,
  resolve-no-change,resolve-with-amendment,restrict,lift-restriction,sync-amendment-progress}
  /route.ts`, `src/app/api/payments/disputes/{claim,record-outcome}/route.ts`;
  `src/lib/disputes/{agreementDisputeService,paymentDisputeService}.ts`.
- **Tables:** `agreement_dispute`, `payment_dispute`.
- **Notifications:** `payment_disputed` (critical).
- **Current UI coverage:** **None.**
- **Pages/components needed:** `/agreements/detail` dispute panel (open dispute, category, evidence
  attach, response, status, resolution — neutral language, no legal-liability claims);
  `/payments/detail/[id]` payment-dispute status card (read-mostly, processor-adjudicated).
  Restriction state (from `agreements/disputes/restrict`) surfaces here too, using the
  user-safe-message pattern from the Restrictions section (Sprint 18 below), not raw errors.
- **Sprint 18B modifies:** Yes.

## Sprint 17 — Notifications

- **Backend capabilities:** notification table/templates/delivery-status/retry/preferences, 25
  event types (verified in `src/lib/notify/eventTypes.ts`), 14 of them critical
  (non-disableable): `payment_failed`, `payment_disputed`, `bank_change`, `card_change`,
  `authorization_revoked`, `security_event`, `staff_permissions`, `payout_account_change`,
  `account_restriction`, `settlement`, `relationship_restricted`,
  `relationship_funding_account_replaced`, `relationship_payout_account_replaced`,
  `appeal_decided`.
- **APIs/services:** `src/app/api/notifications/{route,preferences}.ts`,
  `src/app/api/scheduler/retry-notifications/route.ts`; `src/lib/notify/*`.
- **Tables:** `notification_event`, `notification_preference`.
- **Current UI coverage:** **None.**
- **Pages/components needed:** `/notifications` (Notification Center: read/unread, timestamp,
  title/body, critical badge, deep link to the relevant agreement/payment/relationship/appeal),
  `/account/notifications` preferences (per-channel toggle, critical types shown as
  always-on/non-toggleable, matching the 14-item critical set above exactly).
- **User actions:** mark read/unread, deep-link to source, toggle channel preference per
  non-critical event type.
- **Tests required:** critical-type non-disableable enforcement in the preferences UI, deep-link
  correctness per event type.
- **Sprint 18B modifies:** Yes — this is also the global unread-badge source for the shell nav
  (Phase 2).

## Sprint 18 — Admin / Support / Appeals

- **Backend capabilities:** internal admin roles (support/compliance/fraud_reviewer/admin) +
  13-capability model, retention/legal holds (retention/dispute/fraud-review/litigation),
  restrictions (payment-activity/new-agreements/payout), support cases, appeals with independent-
  reviewer constraint (`appeal_reviewer_not_original_decision_maker` DB check).
- **APIs/services:** `src/app/api/admin/{roles/*,retention/holds/*,restrictions/*,
  support-cases/*,appeals/*,review/*}/route.ts`, `src/app/api/appeals/{route,submit}.ts`;
  `src/lib/admin/*`.
- **Tables:** `admin_role_assignment`, `retention_hold`, `admin_restriction`, `support_case`,
  `appeal`.
- **Roles:** support, compliance, fraud_reviewer, admin (admin has every capability implicitly).
- **Admin capability → label translation:** `suspend_account`→"Suspend account",
  `restrict_payment_activity`→"Restrict payments", `restrict_new_agreements`→"Restrict new
  agreements", `restrict_payout`→"Restrict payouts", `review_verification_status`→"Review
  verification", `review_fraud_alert`→"Review fraud alerts" (no backing data yet — Sprint 19),
  `review_payment_failures`→"Review payment failures", `review_dispute`→"Review disputes",
  `review_audit_logs`→"View audit log", `manage_support_case`→"Manage support cases",
  `manage_appeal`→"Review appeals", `place_retention_hold`/`release_retention_hold`→"Manage legal
  holds".
- **Notifications:** `account_restriction` (critical), `appeal_decided` (critical).
- **Current UI coverage:** **The `/support` page is a static pre-launch placeholder with zero real
  functionality — explicitly fake/mock relative to the now-live backend** (it says "there is no
  live account or agreement functionality... yet", which is no longer true after Sprints 2–18).
  **No support-case, restriction, retention-hold, or appeal UI exists anywhere, user-facing or
  admin.**
- **Fake/mock UI:** `/support` page — must be replaced, not merely supplemented.
- **Backend-without-UI gaps:** the entire domain, both user and admin sides.
- **Pages/components needed:** User-facing: `/support` (replace placeholder — case list, open new
  case, case detail with evidence, appeal-availability + submission where a decision is
  appealable, appeal status/decision). Admin: `/admin/support` (queue), `/admin/restrictions`,
  `/admin/retention-holds`, `/admin/appeals` (reviewer queue — UI must never let the original
  decision-maker self-assign, mirroring the DB constraint), `/admin/audit` (audit trail viewer via
  `review_audit_logs`).
- **Restrictions UX rule (applies everywhere a restricted user hits a blocked action):** show a
  safe generic message ("This action isn't available on your account right now — contact
  support"), never the internal compliance/fraud note.
- **Tests required:** appeal-reviewer-not-original-decision-maker enforced in UI (reviewer picker
  excludes self), restriction-blocked safe-message rendering, capability-label mapping.
- **Sprint 18B modifies:** Yes — replaces `/support`, adds full admin surface. This is the largest
  single UI gap in the repository.

## Sprint 18A — Cooperative Account Pairing / Financial Account Linking / Relationship Architecture

- **Backend capabilities:** relationship (cooperative pairing between two parties) with invitation/
  accept/decline/cancel/expire, financial-account linking with pay-from/receive-to assignment,
  admin relationship-level restriction (`isAdminRole`-gated, distinct from Sprint 18's platform-
  level restriction — deliberately un-merged per `SPRINT_CONTROL.md`'s own documented three-
  mechanism boundary).
- **APIs/services:** `src/app/api/relationships/**/route.ts` (17 routes: route, accept, decline,
  close, detail, activate, activate/check, invite, invite/cancel, invite/resolve, accounts,
  accounts/add, accounts/assign, accounts/party, accounts/replace, evidence,
  evidence/signed-url), `src/app/api/admin/relationships/{accounts,detail,restrict}/route.ts`;
  `src/lib/relationships/*`.
- **Tables:** `relationship`, `relationship_participant`, `relationship_invitation`,
  `financial_account`, `relationship_financial_account`.
- **Notifications:** `relationship_invitation`, `relationship_accepted`, `relationship_declined`,
  `relationship_activated` (non-critical), `relationship_restricted`,
  `relationship_funding_account_replaced`, `relationship_payout_account_replaced` (all three
  critical).
- **Current UI coverage:** **None whatsoever.** This is flagged **mandatory and high priority** by
  the 18B prompt itself, and is the connective tissue every agreement/payment flow depends on
  (an agreement's parties are drawn from an active relationship).
- **Backend-without-UI gaps:** entire domain — this is the single most consequential gap in the
  whole audit, since Agreements/Payments UI (Sprints 5–16) cannot be exercised end-to-end without
  it (no way to establish a counterparty relationship in the first place).
- **Pages/components needed:** `/connections` (list — name, identity type, relevant agreement
  role, status, setup readiness, next action; never raw IDs as labels), `/connections/detail/[id]`,
  `/connections/invitations` (sent + pending), `/connections/invite` (Create Connection wizard:
  choose acting identity → enter invitee → review context → submit → "waiting for counterparty"),
  invitation accept/decline screen (existing-user and new-user-via-signup-resume flows, signup
  must never auto-accept), and a **relationship setup tracker** component (Counterparty connected →
  Funding account ready → Receiving account ready → Agreement ready → Signatures complete →
  Relationship active — re-fetched from backend, never inferred from client form state).
- **User actions:** create connection, choose acting identity, invite, accept, decline, cancel,
  close, assign/replace pay-from and receive-to accounts (with "future payment routing is
  changing" confirmation on replacement).
- **States:** pending/expired invitation, active/restricted/closed relationship, new-user
  invite-resume-after-signup flow.
- **Tests required:** the setup tracker's re-fetch-not-infer behavior, invite/accept/decline/cancel
  flow, Pay-From vs Receive-To account-eligibility filtering (business relationships must use
  organization-owned accounts, never staff personal accounts).
- **Sprint 18B modifies:** Yes — highest-priority build in this sprint per the prompt's own framing.

## Sprint 19 — Fraud/Risk/Security Hardening (not yet built)

No backend exists yet (`review_fraud_alert` capability is declared with no backing data source,
confirmed in `adminCapabilities.ts`'s own comment). Classification:
- **A (buildable now):** none — there is no fraud-indicator/risk-response backend to build UI
  against yet.
- **B (must wait for Sprint 19 backend):** fraud-alert queue, risk-indicator dashboard,
  flag/manual-review/temporary-suspension admin actions, application-security-hardening findings
  display (`docs/SECURITY_AUDIT_REPORT.md` is a document, not a UI surface).
- **C (shared components safe to prepare now):** the admin queue/table/badge components built for
  Sprint 18's support/restriction/appeal queues (Phase 9) are directly reusable for a future
  fraud-alert queue — no separate fraud-specific primitive needs building speculatively.

## Sprint 20 — Closed Beta Readiness (not yet built)

Almost entirely ops/observability/legal-checklist work, not end-user-facing.
- **A:** none.
- **B:** reconciliation-dashboard readiness (depends on Sprint 10 admin ledger UI existing first —
  built in Phase 9/2 of this sprint, so by the time Sprint 20 starts this is actually available),
  beta-user flagging UI, feature-flag/kill-switch admin controls.
- **C:** the admin shell/nav built in Phase 2 is the natural home for future ops/observability
  panels; no speculative UI beyond that shell should be built now.

---

## Cross-cutting design-system requirement

No component library exists today (verified — zero shared `Button`/`Card`/`Badge`/`Dialog`
components in `src/components`). Every phase above depends on Phase 2 producing the shared
primitives (buttons, forms, cards, tables, badges/status chips, dialogs, toasts, empty/loading/
error states, pagination) before domain UI is built, per the prompt's own "Design system" section
— otherwise every subsequent phase duplicates ad hoc styling.

## Summary gap count

- Sprints with real, adequate UI today: 1 (complete). Sprints 2, 3, 5 partially covered.
- Sprints with **zero** UI today: 4, 6, 7, 8 (CSV import portion), 9–17, 18, 18A (17 of 21
  sprint/sub-sprint units, including the two flagged mandatory/high-priority and largest-gap
  domains: Connections/18A and Support-Admin/18).
- One instance of fake/placeholder UI requiring replacement, not augmentation: `/support`.
- One instance of honestly-labeled future placeholder requiring replacement in this sprint per
  spec: the "Staff/Reports — coming in a later phase" lines in `Dashboard.tsx` (Sprint 4/10 now
  have real backends).
