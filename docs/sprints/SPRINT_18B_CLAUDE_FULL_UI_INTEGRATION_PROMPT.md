# Sprint 18B — Full UI/UX Integration Across Sprints 1–20

## Purpose
Insert Sprint 18B before Sprint 19. Its job is to build the complete user-facing UI that exposes the backend capabilities already implemented through Sprint 18/18A, while auditing Sprint 19–20 so the UI architecture is forward-compatible without faking unimplemented backend functionality.

Do not begin Sprint 19.
Do not create cosmetic-only mockups.
Do not create dead buttons.
Do not hardcode fake production data.
Do not duplicate backend business logic in the UI.
Do not silently invent APIs.

## Authoritative sources
Before coding, read:
- PAY2PAY_MASTER_SPEC.md
- CLAUDE.md
- docs/SPRINT_CONTROL.md
- docs/SPRINT_REQUIREMENTS_MATRIX.md
- every Sprint 1–20 specification
- Sprint 18A files/report
- current Next.js layouts, routes, components, APIs, services, repositories, schema, auth/session, role/capability, payment, relationship, notification, admin/support code

The repository is authoritative.

## Branch / execution control
1. Verify master == origin/master and contains Sprint 18A + Sprint 18.
2. Create an isolated worktree/branch named `sprint-18b-full-ui-integration` or repository equivalent.
3. Do not touch unrelated main-checkout scratch/debug files.
4. Execute Sprint 18B only.
5. Do not commit, push, merge, deploy, or begin Sprint 19 before Product Owner review.

# Phase 1 — UI/backend audit before coding
Create `docs/SPRINT_18B_UI_INTEGRATION_MATRIX.md`.

For every actual Sprint 1–20 list:
- sprint number/title
- backend capabilities
- APIs/services
- tables/entities
- user roles
- business capabilities
- notifications
- audit effects
- current UI coverage
- missing UI
- broken/incomplete UI
- fake/mock UI
- backend-without-UI gaps
- UI-without-backend gaps
- pages needed
- components needed
- user actions
- loading/empty/error/confirmation states
- responsive/accessibility needs
- tests required
- whether Sprint 18B will modify it

Do not code until this matrix is complete.

# Core UX architecture
Create one coherent authenticated product shell.

Normal user navigation should include, where backend support exists:
- Dashboard
- Connections
- Agreements
- Payments
- Payment Methods
- Notifications
- Support
- Settings

Use separate role-aware admin navigation for Platform Owner/Admin/support/compliance/fraud-review functions.

Never expose normal users to raw backend terms such as foreign keys, enums, RLS, providerAccountRef, repository names, or ledger posting internals.

# Dashboard
Build a real-data dashboard answering:
- What do I owe?
- What am I expecting?
- What payment is next?
- What requires action?
- Are invitations pending?
- Do I need to sign?
- Do I need to add/verify a financial account?
- Are payments failing?
- Are there disputes/appeals/restrictions?

Every card must deep-link to a real workflow.
No dummy balances.

# Authentication / Sprint 2
Complete UI for:
- signup
- login
- logout
- verification
- forgot/reset password
- expired/invalid reset token
- session expiration
- device/session management where backend supports it
- MFA enrollment/challenge/recovery
- step-up authentication

For sensitive actions, handle step-up seamlessly:
action -> backend says step-up required -> UI challenge -> success -> safely retry original action.
Do not make raw 403 the user experience.

# Profiles / Sprint 3
Complete personal-profile UI using actual schema fields.
Clearly distinguish:
- account/login identity
- personal profile
- organizations represented

# Organizations / Sprint 4
Complete organization UI:
- organization details
- staff/member list
- invite/manage staff if backend supports
- role/capability display in user language
- active/inactive staff
- organization context switching

Translate internal capabilities into understandable labels.
Example: `change_payout_configuration` -> "Manage payout accounts".

# Admin / Sprint 6A + Sprint 18
Create a separate admin surface using actual backend authorization.

Support:
- user lookup
- organization lookup
- relationship lookup
- agreement lookup
- support/compliance/fraud-review cases
- restrictions
- legal/retention holds
- appeals
- audit trail
- session/account troubleshooting where permitted

Platform Owner-only actions must remain Owner-only.
Mask all financial account data.
Never expose PAN, CVV, full account numbers, provider secrets, session tokens, password hashes, MFA secrets.

# Connections / Sprint 18A
This is mandatory and high priority.

Create:
- Connections list
- Connection detail
- Pending invitations
- Sent invitations
- Invite Counterparty
- Accept
- Decline
- Cancel
- Expired state
- Setup-progress page
- Active/restricted/closed states

Show people/business names, identity type, relevant agreement role, status, setup readiness, and next action.
Do not use raw IDs as primary labels.

# Cooperative handshake UX
Initiator flow:
1. Create Connection
2. Choose acting identity: self or authorized organization
3. Enter invitee
4. Review relationship context
5. Submit
6. Show "waiting for counterparty acceptance"

Existing invitee flow:
1. Open invitation
2. See inviter/context
3. Select eligible personal/business identity
4. Explicit Accept or Decline
5. Continue setup

New-user flow:
invite -> signup/login -> verification -> invitation resumed -> explicit acceptance.
Signup must never auto-accept a financial relationship.

# Relationship setup tracker
Create an authoritative progress tracker such as:
1. Counterparty connected
2. Funding account ready
3. Receiving account ready
4. Agreement ready
5. Signatures complete
6. Relationship active

Re-fetch authoritative backend state.
Do not infer completion from client form submission.
Clearly show which party is responsible for each missing step.

# Financial Accounts
Create Payment Methods UI with:
- Bank Accounts
- Debit Cards
- verification status
- masked last 4
- institution/brand metadata where safe
- active/inactive
- funding eligibility
- payout eligibility
- relationship assignment where appropriate

Never display raw credentials.

# Add Bank Account
Use the existing ACH/provider/tokenization architecture.
Flow:
authenticated actor -> select personal/business identity -> add account -> provider/tokenization -> verification -> internal account -> assignment eligibility.

Handle:
- pending verification
- verified
- failed verification
- provider error
- invalid details
- duplicate account where supported
- cancellation/timeouts

Never put bank credentials in localStorage or console logs.

# Debit Cards
Use Sprint 12 backend:
- add card
- masked card display
- brand/expiry only if backend safely provides it
- verification/eligibility
- funding assignment

Never retain/display CVV or full PAN.

# Pay From vs Receive To
Within relationship setup clearly separate:
- Pay From
- Receive To

Only show accounts owned by the correct participant and eligible for that usage.
Business relationships must use organization-owned accounts, not staff personal accounts.

Replacement must preserve history and show a clear confirmation that future payment routing is changing.

# Agreements / Sprint 5
Build:
- agreement list/detail
- status
- parties
- amount
- payment schedule
- fee allocation
- current version
- version history
- signature state
- amendment/history links
- settlement links
- dispute links

Signed agreements must not look directly editable.

# Agreement creation wizard
Where backend supports creation:
1. Parties
2. Amount/obligation
3. Schedule
4. Payment setup/readiness
5. Terms review
6. Send for signature

Use backend validation.
Protect against duplicate agreement creation on refresh/retry.

# Signatures / Sprint 6
Show:
- exact agreement/version
- signer
- required consent text
- signature status
- completion timestamp

Use real signature/evidence backend.
Do not replace strong backend signature requirements with a checkbox.

# Documents / Evidence / Sprint 7 + 18A
Expose authorized:
- agreement PDFs
- signature evidence
- dispute evidence
- amendment docs
- settlement records
- support/appeal evidence

Use existing authorized routes.
No public bypass URLs.

# B2B / Sprint 8
Businesses must have first-class UX:
- clear organization context
- organization-owned financial accounts
- staff capability boundaries
- customer/business connections

If CSV import is available, UI must reflect backend state honestly.
Never auto-activate a relationship when backend only creates pending invitations.

# Payments / Sprints 9–12
Create unified payment history/detail UI:
- amount
- date
- status
- counterparty
- agreement
- installment
- method
- attempts
- retry state
- dispute state
- partial/settlement linkage where relevant

Use plain-language status labels.
Do not expose raw processor errors.

# ACH / Sprint 11
Show:
- verification pending
- verified
- mandate required
- mandate active
- unavailable

Guide users to required mandate/verification actions.

# Failed Payments / Sprint 13
Failed-payment UI should show:
- safe failure category
- next step
- scheduled retry
- retry date
- manual payment option where backend supports it
- reschedule option where supported

# Reschedule
Debtor:
request -> permitted date -> submit -> awaiting creditor decision.
Creditor:
review -> approve/reject -> see schedule impact.
Enforce business capability rules.

# Amendments / Hardship / Sprint 14
Show current vs proposed terms with clear diff.
Support:
- new date
- pause
- reduced installment
- revised schedule
- general permitted amendment
- counteroffer
- accept/reject

Never overwrite original terms.
Display version/history.

# Partial Payments / Sprint 15
Show:
- scheduled amount
- partial amount
- remainder
- status
- proposal/counterparty decision
- resulting obligation

Never imply partial payment satisfies full debt unless backend says so.

# Settlements / Sprint 15
Support and clearly distinguish:
- proposed
- accepted
- payment required
- pending payment
- completed
- failed
- expired
- rejected
- cancelled

Critical rule:
"Accepted" must never visually equal "Paid" or "Completed".

Show:
- original/outstanding balance
- settlement amount
- amount forgiven only after completion
- deadline
- proposer/decision
- payment state

# Disputes / Sprint 16
Build:
- open permitted dispute
- reason
- evidence
- case state
- responses where allowed
- resolution
- restriction state if exposed

Use neutral language.
Do not claim the platform determines legal liability beyond the backend/spec.

# Notifications / Sprint 17
Create Notification Center:
- read/unread
- timestamps
- title/body
- critical indicator
- deep link
- preferences where backend supports

Do not allow disabling critical notifications if backend forbids it.

# Support / Appeals / Sprint 18
Normal users:
- support cases
- case detail
- evidence
- appeal availability
- appeal submission
- appeal status
- decision/rationale where authorized

Admin:
- queues
- support/compliance/fraud review
- restrictions
- legal holds
- appeals
- reviewer workflow
- audit history

UI must not bypass independent-review constraints.

# Restrictions
When a normal-user operation is blocked, show a safe, useful message instead of raw backend errors.
Do not expose internal fraud/compliance notes.

# Legal/Retention Holds
Admin-only unless spec says otherwise.
Show:
- hold type
- target
- date
- actor
- active/released
- reason where authorized

Never expose deletion actions that backend forbids.

# Sprint 19–20 readiness
Read both specs fully.
For every feature classify:
A. UI can be built now against existing backend.
B. UI must wait for Sprint 19/20 backend.
C. Shared components/layout may be safely prepared now.

Do not create fake functional controls for category B.

# Design system
Standardize:
- typography
- spacing
- buttons
- links
- forms
- inputs
- selects
- radio/checkbox
- tabs
- cards
- dialogs
- drawers
- banners
- badges/status chips
- tables
- pagination
- empty states
- skeletons
- toasts
- error summaries

Use confirmations for material financial/admin actions.

# Status presentation
Create centralized mapping from backend enums to user language.
Do not leak raw enum strings.

Examples:
- `pending_verification` -> "Verification pending"
- `counterparty_linked` -> "Connected"
- `signature_pending` -> "Waiting for signatures"
- `pending_payment` -> "Payment required"

# Money presentation
Use one formatter.
Browser formats only; backend calculates.
Use consistent currency/precision.

# Date/time
Use consistent local-time presentation where appropriate.
Preserve exact audit/legal timestamps where required.
Never mix UTC and local silently.

# Responsive design
Normal-user flows must work on:
- mobile
- tablet
- desktop

Do not shrink desktop tables onto phones.
Use responsive cards/lists.
No horizontal page overflow.

# Accessibility
Meet practical WCAG AA:
- semantic landmarks
- keyboard navigation
- visible focus
- form labels
- described errors
- heading hierarchy
- contrast
- non-color status cues
- dialog focus management
- actual buttons/links

# Loading / error / empty states
Every async route/action must have:
- deliberate loading state
- duplicate-submit protection
- safe error state
- meaningful empty state

Handle 400/401/403/404/409/422/429/500/network failures.
Never expose stack traces, SQL errors, internal paths, provider secrets, raw internal exceptions.

# Security UX
Do not:
- persist authoritative balances/statuses only in client state
- store payment secrets/MFA secrets in localStorage
- log sensitive data
- trust client-supplied acting user/organization IDs
- expose admin-only data

Browser authorization is presentation only; server remains authoritative.

# API integration rule
For every active control document the real API/service it invokes.

If UI needs an API adapter:
- add only a thin route over existing backend capability
- keep business rules in services
- do not materially expand backend scope without stopping and reporting

# Testing
Add UI/component/integration coverage for at least:
- money formatting
- status mappings
- permission-aware actions
- relationship setup tracker
- financial account cards
- settlement state display
- failed-payment UI
- critical notifications

Add workflow tests for:
1. signup/login
2. MFA/step-up
3. profile
4. organization context
5. invite counterparty
6. accept/decline invite
7. add bank account
8. verification state
9. funding assignment
10. payout assignment
11. agreement review
12. signature
13. payment detail
14. failed payment/retry
15. reschedule
16. amendment
17. partial payment
18. settlement proposal/accept/pending/completed
19. dispute
20. notifications
21. support case
22. appeal
23. admin restriction
24. legal hold

Where E2E tooling exists, add representative P2P, B2C, and B2B journeys.

# P2P E2E
Ahmad owes Bilal:
- Ahmad invites Bilal
- Bilal accepts
- Ahmad adds/selects verified funding
- Bilal adds/selects payout
- agreement linked
- signatures complete
- relationship active
- payment schedule visible
- payment/notification visible

Also verify reversed roles in a separate relationship do not change global identity.

# B2C E2E
Business ABC ↔ Jane:
- authorized business rep
- Jane accepts
- Jane personal funding
- ABC organization payout
- staff capability enforcement
- no personal business-staff account substitution

# B2B E2E
Company A ↔ Company B:
- authorized reps
- organization-owned accounts
- agreement/payment context
- unauthorized staff denied
- cross-org isolation

# Regression
Run:
- complete existing test suite
- new UI tests
- typecheck
- lint
- production build
- drizzle/schema check
- E2E if configured

Zero backend regressions expected.

# Final route audit
Inspect every visible route for:
- real data
- authorization
- loading
- empty state
- error state
- responsive layout
- accessibility
- no dead links/buttons
- no console errors
- no fake data
- no raw backend enum leakage
- no sensitive data leakage

# Completion documentation
Create:
`docs/sprints/SPRINT_18B_UI_COMPLETION_REPORT.md`

For every Sprint 1–20 include:
- actual title
- backend capability
- UI implemented
- page/route
- actions
- backend connector
- authorization/capability behavior
- responsive status
- accessibility status
- tests
- known limitations
- PASS/PARTIAL/FAIL

For Sprint 19/20 distinguish future backend dependency from UI work safely completed now.

# Product Owner handoff
When complete:
- Do not commit
- Do not push
- Do not merge
- Do not deploy
- Do not begin Sprint 19

Report:
1. Branch/worktree
2. UI matrix path
3. Routes audited
4. Backend-without-UI gaps found/fixed
5. UI-without-backend gaps found/fixed
6. Global navigation/dashboard/design-system changes
7. Sprint-by-Sprint UI 1–20
8. Relationship handshake UX
9. Bank/card/account-assignment UX
10. Agreements/signatures/docs UX
11. Payments/retry/amendment/partial/settlement/dispute UX
12. Notification UX
13. Support/admin/appeal UX
14. Security/authorization behavior
15. Responsive/accessibility results
16. Tests added
17. Total tests passing
18. Typecheck/lint/build/drizzle/E2E results
19. Known limitations
20. Explicit PASS/PARTIAL/FAIL for every Sprint 18B requirement

End with:

**Awaiting ChatGPT/Product Owner Sprint 18B UI/UX review. I will not commit, push, merge, deploy, or begin Sprint 19.**
