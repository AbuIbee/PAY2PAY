Begin implementation of **Sprint 18A — Cooperative Account Pairing, Financial Account Linking & Relationship Architecture**.

This is a deliberately inserted infrastructure sprint. It does **not** replace the existing Sprint 18 specification.

Before writing code, read and reconcile:

- `PAY2PAY_MASTER_SPEC.md`
- `CLAUDE.md`
- `docs/SPRINT_CONTROL.md`
- every completed Sprint 1–17 specification
- planned Sprint 18–20 specifications
- current database schema
- all existing migrations
- all existing RLS policies
- current authentication/profile/business-permission architecture
- current agreement/signature/document/payment/ledger/dispute/notification architecture
- current ACH and debit-card provider abstractions
- current audit/admin architecture

The repository is authoritative.

Do not guess.

Do not duplicate an existing component merely because this prompt describes a conceptual model.

If an equivalent implementation already exists, reuse and extend it.

If this prompt conflicts with an established security, payment, ledger, agreement-versioning, signature, RLS, or audit invariant, stop and report the conflict before modifying that architecture.

---

# EXECUTION CONTROL

First verify that the most recent completed sprint is merged into `origin/master` and that Sprint 18A will branch from the correct synchronized master tip.

Create a new isolated worktree and branch:

` sprint-18a-relationship-architecture `

or the repository's established naming equivalent.

Do not work directly in the dirty main checkout.

Do not modify, delete, stage, commit, or otherwise touch unrelated pre-existing modified/untracked files in the main checkout.

Execute **Sprint 18A only**.

Do not begin Sprint 18.

Do not commit, push, merge, deploy, or open a PR until Product Owner review unless `docs/SPRINT_CONTROL.md` explicitly requires otherwise.

---

# PHASE 1 — ARCHITECTURE DISCOVERY BEFORE CODING

Before implementing anything, perform a repository-wide architecture audit.

Produce an internal Sprint 1–20 connector matrix using the **actual sprint files and actual sprint titles**.

For every Sprint 1–20 identify:

- sprint number
- sprint title
- primary tables/entities
- services
- APIs/routes
- authorization/capability model
- audit integration
- notification integration
- relationship to users
- relationship to organizations
- relationship to agreements
- relationship to financial accounts
- relationship to payments
- relationship to ledger
- existing foreign keys/correlation IDs
- missing relationship connector
- whether Sprint 18A must modify it
- regression tests required

Do not hard-code assumed sprint names.

Read the files.

Also explicitly answer before coding:

1. What existing tables represent users?
2. What existing tables represent individual profiles?
3. What existing tables represent organizations?
4. How are organization members/staff represented?
5. How are organization capabilities represented?
6. How are agreements represented?
7. How are agreement versions represented?
8. How are signatures represented?
9. How are documents/evidence represented?
10. How are installments represented?
11. How are ACH accounts represented?
12. How are debit cards represented?
13. How are provider tokens/references represented?
14. How are payments represented?
15. How are ledger entries represented?
16. How are retries represented?
17. How are amendments represented?
18. How are settlements represented?
19. How are disputes represented?
20. How are notifications represented?
21. How are audits represented?
22. Where are payer/receiver/debtor/creditor identities stored today?
23. Where are those identities duplicated?
24. Where are relationships currently implicit rather than explicit?
25. Which existing paths can already derive both counterparties?
26. Which tables would become orphaned or ambiguous without a first-class relationship ID?

Document the result in the Sprint 18A implementation notes before making schema changes.

---

# PHASE 2 — CORE ARCHITECTURAL PRINCIPLE

The architecture must enforce:

**Accounts belong to people or organizations.**

**Payment roles belong to relationships and agreements.**

Do not globally classify an account as:

- borrower
- lender
- debtor
- creditor
- payer
- receiver

A single individual or organization must be able to participate in multiple relationships simultaneously and hold different roles in each relationship.

Examples:

- User A owes User B.
- User A receives repayment from User C.
- User A represents Organization X.
- Organization X receives from Organization Y.
- Organization X pays User D.

This must not require duplicate user accounts.

---

# PHASE 3 — PARTY / ACTOR MODEL

Inspect whether a generic party or actor abstraction already exists.

If it does, reuse it.

If not, implement the minimum normalized architecture necessary to support both:

- INDIVIDUAL
- ORGANIZATION

Do not force organization relationships through personal user IDs.

The data model must support:

- Individual ↔ Individual
- Individual ↔ Organization
- Organization ↔ Individual
- Organization ↔ Organization

Prefer strong relational integrity.

If using nullable party references, enforce exactly one valid target with database CHECK constraints.

Do not create loose polymorphic text IDs if proper foreign keys are feasible.

The authenticated **user** is the actor.

The **party** is the individual or organization the actor represents.

Those are not the same concept.

---

# PHASE 4 — FIRST-CLASS PAYMENT RELATIONSHIP

Create or identify the canonical relationship entity.

Conceptual identifier:

`REL`

Do not rename mature IDs merely to match this prefix.

Every new financially meaningful flow should be deterministically traceable to a relationship.

Relationship must record at minimum:

- relationship_id
- relationship type/context if required
- status
- initiator user
- created_at
- updated_at
- activated_at nullable
- restricted_at nullable
- closed_at nullable
- correlation/audit metadata

Use repository-standard ID generation.

Do not use client-generated authoritative IDs unless already safe by design.

---

# PHASE 5 — RELATIONSHIP PARTICIPANTS

Create or identify relationship participants.

Each principal participant must resolve to exactly one:

- individual profile
- organization

Required participant data should include:

- relationship_participant_id
- relationship_id
- individual_profile_id nullable
- organization_id nullable
- relationship role
- payment-direction role if necessary
- participant status
- represented_by_user_id where relevant
- joined_at
- left_at nullable
- created_at
- updated_at

Enforce participant uniqueness and party integrity.

For the existing two-party repayment model, enforce exactly two principal counterparties unless the actual master spec explicitly allows more.

Do not create duplicate participant rows through retry or repeated invitation acceptance.

---

# PHASE 6 — COOPERATIVE ACCOUNT HANDSHAKE

This is a mandatory Sprint 18A capability.

A financial relationship may not become active because one person typed another person's email address.

Implement a two-sided cooperative handshake.

The handshake must establish:

- who initiated
- which party the initiator represents
- who is invited
- which party the invitee represents
- proposed relationship context
- proposed financial role
- authenticated acceptance or rejection
- organizational authority where applicable
- immutable counterparty linkage
- full audit history

No party can accept on behalf of another without verified authority.

---

# PHASE 7 — INVITATION MODEL

Implement or extend an invitation model.

Use repository naming conventions.

Conceptual lifecycle:

- DRAFT
- SENT
- DELIVERED
- VIEWED
- ACCEPTED
- DECLINED
- EXPIRED
- CANCELLED
- SUPERSEDED

Only include states that are justified by the existing architecture, but lifecycle semantics must be explicit.

Invitation must record at minimum:

- invitation_id
- inviter_user_id
- inviter represented party
- invitee locator
- resolved invitee user when known
- resolved invitee party when known
- proposed relationship context
- proposed role/context
- status
- created_at
- expires_at
- viewed_at
- accepted_at
- declined_at
- cancelled_at
- correlation ID
- audit metadata

Invitation token must be cryptographically strong.

Do not store a reusable plaintext token.

Use token hashing/verifier conventions already present in the repository where possible.

Protect against:

- token guessing
- token replay
- cross-user acceptance
- expired-token acceptance
- duplicate acceptance
- tampering
- invitation hijacking

---

# PHASE 8 — EXISTING USER HANDSHAKE

For an existing platform user:

1. Party A creates invitation.
2. Server verifies A's authority.
3. Invitation is stored.
4. Notification is sent using Sprint 17 notification architecture.
5. Party B authenticates.
6. B opens the invitation.
7. Server verifies the invitation is intended for B.
8. B chooses an eligible party identity if B can represent more than one:
   - personal profile
   - authorized organization
9. Server verifies B's authority for the selected party.
10. B accepts or declines.
11. Acceptance creates or links the relationship participants.
12. Invitation becomes ACCEPTED atomically.
13. Audit events are recorded.
14. Duplicate/replayed acceptance remains idempotent.

Do not let a logged-in account accept an invitation for another identity without explicit authorization.

---

# PHASE 9 — NEW USER HANDSHAKE

For an invitee who does not yet have an account:

1. Create pending invitation.
2. Send secure enrollment/relationship notification.
3. Invitee creates account using existing authentication.
4. Invitee completes required account verification.
5. Server resolves eligible pending invitation(s).
6. Invitee creates/selects personal or business identity.
7. Invitee explicitly reviews the relationship request.
8. Invitee accepts or declines.
9. Only explicit acceptance creates relationship participation.

**Signup must never automatically accept a financial relationship.**

---

# PHASE 10 — BUSINESS HANDSHAKE & CAPABILITIES

Integrate Sprint 4 business permission architecture.

A user acting for an organization must have:

- active organization membership
- active organization
- correct business capability

Verify capabilities separately for material actions such as:

- create relationship invitation
- accept relationship invitation
- select organization as principal
- add financial account
- assign funding account
- assign payout account
- replace account
- create/approve agreement if applicable
- perform binding settlement/amendment actions
- close/restrict relationship if applicable

Do not treat organization membership alone as sufficient authority.

Do not bypass the capability model with a generic "staff" check.

Authorization must be server-side.

---

# PHASE 11 — RELATIONSHIP ROLE MODEL

Do not globally change user account types.

Use relationship/agreement-specific roles.

Reuse existing debtor/creditor terminology where already authoritative.

Possible conceptual mapping:

- debtor / obligor
- creditor / obligee
- payer
- receiver

Do not create duplicate competing semantics.

If an agreement permits only one payment direction, preserve that model.

A relationship may contain multiple agreements over time if needed.

Do not corrupt the agreement engine merely to allow role reversal.

---

# PHASE 12 — RELATIONSHIP LIFECYCLE

Implement an explicit server-enforced state machine.

Conceptually:

INVITED  
→ COUNTERPARTY_LINKED  
→ IDENTITIES_CONFIRMED  
→ FINANCIAL_SETUP_PENDING  
→ FINANCIAL_ACCOUNTS_READY  
→ AGREEMENT_PENDING  
→ AGREEMENT_READY  
→ SIGNATURE_PENDING  
→ SIGNED  
→ ACTIVE

Potential additional states:

- RESTRICTED
- SUSPENDED
- DISPUTED
- CLOSED
- CANCELLED
- ARCHIVED

Use actual project terminology where available.

Invalid transitions must fail closed.

Do not allow browser code to directly assign lifecycle status.

Provide a transition service or equivalent invariant enforcement.

---

# PHASE 13 — ACTIVATION GATE

A relationship must not become ACTIVE until required prerequisites are complete.

Server-side activation validation must inspect, as applicable:

- both counterparties linked
- both identities resolved
- organization authority valid
- financial setup complete
- funding account valid
- payout account valid
- bank verification complete
- mandate active where required
- governing agreement exists
- current agreement version resolved
- required signatures complete
- no blocking restriction
- no blocking dispute
- required step-up authentication performed
- account/organization statuses active

Return explicit machine-readable failure reasons for incomplete prerequisites.

Do not make this a UI-only checklist.

---

# PHASE 14 — FINANCIAL ACCOUNT OWNERSHIP MODEL

Users and organizations must be able to add financial account information.

Financial accounts belong to parties.

They do **not** belong permanently to one agreement or one relationship.

Correct logical structure:

Party  
→ Financial Account  
→ Relationship Financial Account Assignment

A verified party account may be reused across authorized relationships.

Support existing account types such as:

- BANK_ACCOUNT
- DEBIT_CARD

only where the provider/payment architecture supports them.

Reuse Sprint 11 ACH and Sprint 12 debit-card architecture.

Do not create a second payment-provider abstraction.

---

# PHASE 15 — BANK ACCOUNT ADDITION

Implement or connect a user-facing/server-side bank-account workflow.

Required logical flow:

Authenticated actor  
→ select represented party  
→ add bank account  
→ provider/tokenization boundary  
→ verification  
→ internal financial-account record  
→ account available for relationship assignment

The user/business must be able to provide the information required by the existing ACH provider/sandbox architecture.

Do not store sensitive banking credentials in application tables if the provider architecture already tokenizes them.

Production-safe architecture should retain only values such as:

- provider token/account reference
- financial account ID
- masked last digits
- account subtype
- institution display information
- verification status
- ownership status
- eligibility status
- mandate status
- created_at
- verified_at
- disabled_at

Never expose raw provider secrets to client code.

Never log full bank details.

---

# PHASE 16 — BANK VERIFICATION

Reuse the existing verification mechanism.

Potential supported mechanisms may include:

- sandbox verification
- provider instant verification
- micro-deposit verification

Do not invent another verification framework.

Relationship architecture should consume authoritative states such as:

- PENDING
- VERIFIED
- FAILED
- DISABLED

or the existing equivalent.

An account requiring verification must not become eligible before verification completes.

---

# PHASE 17 — FINANCIAL ACCOUNT AUTHORIZATION

A party may have multiple financial accounts.

Create or identify a relationship-scoped account assignment.

Conceptual model:

`relationship_financial_account_assignment`

Required fields should include:

- assignment_id
- relationship_id
- relationship_participant_id
- financial_account_id
- usage
- payment direction
- status
- selected_by_user_id
- effective_from
- effective_to
- superseded_by
- created_at
- updated_at

Usage should distinguish at minimum:

- FUNDING
- PAYOUT / RECEIVING

Use BOTH only if technically supported.

Enforce:

- financial account belongs to correct party
- account is active
- account is verified when required
- account is eligible for requested use
- actor is authorized to assign it
- unrelated party cannot select it

---

# PHASE 18 — FINANCIAL ACCOUNT REPLACEMENT

Changing the active bank or funding destination is a financially material event.

Do not overwrite history.

Replacement flow should:

1. validate actor
2. validate account ownership
3. validate account eligibility
4. create new assignment
5. supersede/close prior assignment
6. preserve historical payment references
7. audit the change
8. notify relevant party if required
9. preserve effective timestamps

Determine from the existing agreement/security architecture whether counterparty approval is required.

Do not invent mutual approval if it is not required, but do not silently bypass it if existing agreements require it.

---

# PHASE 19 — FUNDING VS RECEIVING ACCOUNTS

The architecture must explicitly distinguish:

**where money is pulled from**

from

**where money is delivered**

Do not assume they are the same.

Relationship must support the appropriate direction for:

- ACH funding
- ACH payout/receiving
- debit-card funding
- future supported rails

Do not imply debit-card payout support unless the existing provider architecture supports it.

---

# PHASE 20 — ACH CONNECTOR

Reuse Sprint 11.

Relationship account assignment must connect correctly to:

- ACH account/provider token
- bank verification
- mandate
- payment-provider abstraction

Do not bypass mandate requirements.

Do not create raw ACH execution inside RelationshipService.

---

# PHASE 21 — DEBIT CARD CONNECTOR

Reuse Sprint 12.

Relationship must be able to identify the correct authorized debit-card funding method where applicable.

Do not create separate card storage.

Do not duplicate provider tokens.

Do not store PAN or CVV.

---

# PHASE 22 — PAYMENT PROVIDER BOUNDARY

Maintain separation:

Relationship Architecture:
- identifies parties
- identifies agreement
- identifies funding source
- identifies payout destination
- identifies authorized direction

Payment Orchestration:
- creates/executes payment request

PaymentProvider:
- communicates with the external/sandbox processor

Do not put processor-specific logic into the relationship layer.

---

# PHASE 23 — AGREEMENT CONNECTOR

Every active repayment arrangement must resolve:

relationship  
→ governing agreement

If agreements do not currently carry relationship context, add the minimum additive linkage required.

Do not rewrite historical agreement logic.

Preserve:

- original agreement
- current version
- prior immutable versions
- version chain
- signatures
- amendments
- hardship modifications
- settlements

Relationship is context, not a replacement for agreement versioning.

---

# PHASE 24 — SIGNATURE CONNECTOR

Reuse existing signature/evidence architecture.

Relationship activation should consume authoritative signature completion state.

Do not create duplicate relationship-level signatures if agreement signatures already represent legal consent.

Ensure the correct participants signed the correct agreement/version.

Where Sprint 6 stronger evidence is required, preserve it.

---

# PHASE 25 — DOCUMENT / EVIDENCE CONNECTOR

Relationship-scoped access must support authorized retrieval of:

- agreement documents
- signature evidence
- PDFs
- dispute evidence
- amendment records
- settlement records
- other relevant documents

Reuse existing document/evidence services.

Do not create duplicate storage architecture.

Enforce participant and organization authorization.

---

# PHASE 26 — B2B CONNECTOR

Business relationships must support:

- Individual ↔ Business
- Business ↔ Individual
- Business ↔ Business

CSV/bulk workflows may create invitations but may not silently create ACTIVE financial relationships without required consent.

Business financial accounts must belong to the organization, not the staff member's personal identity.

Business payouts must not route through a representative's personal account.

---

# PHASE 27 — PAYMENT CONNECTOR

Every payment must be deterministically attributable to:

- relationship
- agreement
- payer participant
- receiver participant
- installment if applicable
- funding account assignment
- payout assignment
- payment method
- provider reference
- ledger correlation ID

Do not trust client-supplied party/account IDs when the server can derive them.

Protect against account-substitution attacks.

---

# PHASE 28 — INSTALLMENT CONNECTOR

Installments must resolve relationship context.

Prefer derivation through agreement if that is unambiguous and efficient.

Add direct relationship linkage only if required for integrity/performance.

Do not create redundant state that can drift.

---

# PHASE 29 — LEDGER CONNECTOR

The existing ledger remains the financial source of truth.

Do not add another balance engine.

Every ledger event associated with a relationship payment must be traceable through an immutable chain such as:

ledger entry  
→ payment  
→ agreement  
→ relationship

If adding direct `relationship_id` to ledger materially improves integrity, document the justification and ensure there is no opportunity for inconsistency.

---

# PHASE 30 — FAILED PAYMENT / RETRY CONNECTOR

Reuse Sprint 13.

Retries must preserve:

- relationship
- agreement
- installment
- payer
- receiver
- funding account
- payout account

unless an authorized account change occurred.

Do not let a retry accidentally use an unrelated current account assignment when the original payment must remain historically tied to its original assignment.

Distinguish historical payment attribution from a newly authorized retry source if the architecture permits replacement.

---

# PHASE 31 — AMENDMENT / HARDSHIP CONNECTOR

Reuse Sprint 14.

Relationship must resolve the current effective agreement version.

Do not mutate original terms.

An amendment does not create a new unrelated relationship unless the existing architecture explicitly requires one.

Preserve role/participant continuity.

---

# PHASE 32 — PARTIAL PAYMENT CONNECTOR

Reuse Sprint 15.

Partial payment must resolve:

- relationship
- agreement
- specific obligation/installment

Do not attach by party pair alone.

Two parties may have multiple concurrent agreements.

---

# PHASE 33 — SETTLEMENT CONNECTOR

Reuse Sprint 15.

Settlement must resolve the correct relationship and agreement.

Preserve the existing invariant:

**settlement accepted != debt paid**

Debt is only extinguished after confirmed settlement payment according to the ledger/payment architecture.

Do not weaken this invariant.

---

# PHASE 34 — DISPUTE CONNECTOR

Reuse Sprint 16.

Agreement and payment disputes must resolve relationship context.

If a dispute causes restriction:

- relationship state should reflect it where appropriate
- authoritative payment execution path must enforce the restriction if required

Do not rely on a UI banner to stop payment execution.

Preserve existing dispute evidence and resolution history.

---

# PHASE 35 — NOTIFICATION CONNECTOR

Reuse Sprint 17 `NotificationService`.

Integrate relationship lifecycle events such as:

- relationship invitation created
- invitation viewed
- invitation accepted
- invitation declined
- invitation expired
- financial account required
- financial account verification succeeded
- financial account verification failed
- funding account assigned
- payout account assigned
- agreement ready
- signature required
- relationship activated
- relationship restricted
- relationship closed

Do not create a second notification system.

Respect existing notification preferences and critical-notification rules.

---

# PHASE 36 — AUDIT CONNECTOR

Reuse the existing audit architecture.

Audit all material relationship events.

At minimum:

- RELATIONSHIP_INVITATION_CREATED
- RELATIONSHIP_INVITATION_SENT
- RELATIONSHIP_INVITATION_VIEWED
- RELATIONSHIP_INVITATION_ACCEPTED
- RELATIONSHIP_INVITATION_DECLINED
- RELATIONSHIP_INVITATION_EXPIRED
- RELATIONSHIP_CREATED
- RELATIONSHIP_PARTICIPANT_LINKED
- RELATIONSHIP_PARTY_CONFIRMED
- RELATIONSHIP_ROLE_CONFIRMED
- FINANCIAL_ACCOUNT_ADDED
- FINANCIAL_ACCOUNT_VERIFIED
- FINANCIAL_ACCOUNT_ASSIGNMENT_CREATED
- FINANCIAL_ACCOUNT_ASSIGNMENT_REPLACED
- AGREEMENT_LINKED
- RELATIONSHIP_ACTIVATED
- RELATIONSHIP_RESTRICTED
- RELATIONSHIP_SUSPENDED
- RELATIONSHIP_CLOSED

Preserve:

- actor
- represented party
- organization
- relationship ID
- timestamp
- before/after state where relevant
- correlation ID

Do not create a parallel audit mechanism.

---

# PHASE 37 — ADMIN CONNECTOR

Integrate existing Platform Owner/Admin architecture.

Authorized administrators may inspect relationship state for support/audit purposes.

Admin views/services may expose:

- relationship ID
- participants
- organizations
- lifecycle status
- agreement linkage
- financial-account status
- masked account information
- payment state
- dispute state
- audit trail

Do not expose:

- full bank account number
- CVV
- PAN
- provider secret
- reusable invitation token
- authentication secrets

Administrative access to financially sensitive relationship records should itself be audited.

Do not give lower admin roles unrestricted powers if Sprint 6A prohibits them.

---

# PHASE 38 — SECURITY / FRAUD EVENT SURFACES

Do not build a full fraud engine unless an actual sprint already owns it.

But Sprint 18A must generate sufficient structured events/audit information to support later detection of:

- invitation flooding
- repeated token failures
- relationship creation velocity
- repeated bank verification failure
- bank account ownership conflicts
- rapid financial-account replacement
- unauthorized business representation
- repeated invitation cancellation/recreation
- unusual relationship churn

Do not expose internal risk signals to normal users.

---

# PHASE 39 — RELATIONSHIP OWNERSHIP RULES

A cooperative relationship has principals, not a single unilateral owner.

The creator is the **initiator**.

The initiator cannot:

- remove the other principal arbitrarily
- accept for the other party
- change the other party's bank account
- change the other party's payout destination
- sign for the other party
- transfer the relationship to another identity
- modify signed agreement terms outside amendment workflows
- settle on behalf of the counterparty without authorization

Enforce server-side.

---

# PHASE 40 — IDEMPOTENCY

Material handshake operations must be idempotent.

Protect:

- invitation creation where idempotency key exists
- invitation acceptance
- participant creation
- relationship creation
- financial assignment
- activation
- notification emission where duplicate delivery is harmful

Repeated clicks or network retries must not create duplicate financial relationships.

---

# PHASE 41 — MULTIPLE VALID RELATIONSHIPS

Do not impose a naive unique constraint that prevents the same two parties from having more than one legitimate relationship/agreement.

Examples:

- separate debts
- personal relationship and business relationship
- multiple contracts
- multiple repayment arrangements

Duplicate prevention should target repeated creation attempts, not legitimate business cases.

---

# PHASE 42 — PRIVACY

Before acceptance, expose only the identity information necessary to recognize the intended counterparty.

After acceptance, do not reveal:

- unrelated financial accounts
- unrelated relationships
- unrelated organization memberships
- unrelated agreement history
- full financial credentials
- internal admin notes
- internal risk/fraud signals

Use RLS plus service authorization.

---

# PHASE 43 — RLS

Apply RLS to every new relationship-oriented table.

Test at minimum:

User A ↔ User B relationship:
- A can access according to role
- B can access according to role
- User C cannot read it

Organization X ↔ User A:
- authorized Organization X staff can access allowed scope
- unauthorized staff cannot
- inactive/former staff cannot
- User B cannot

Organization X ↔ Organization Y:
- authorized staff from each organization can access allowed scope
- unrelated organizations cannot

Do not rely solely on API filtering.

Add `REVOKE` protections consistent with previous migrations.

---

# PHASE 44 — DATABASE INVARIANTS

Use database constraints where practical.

Examples:

- exactly one participant party target
- relationship cannot contain duplicate principal party
- accepted invitation can resolve only once
- financial account must belong to assigned participant
- only eligible active assignment may occupy a required slot
- lifecycle timestamps consistent with state
- valid enum transitions where enforceable
- no orphan foreign keys

Do not move basic referential integrity into application code alone.

---

# PHASE 45 — DELETION / RETENTION

Do not hard-delete financially significant history.

Use lifecycle concepts such as:

- inactive
- revoked
- superseded
- closed
- archived

Provider-side account unlinking may remove access to credentials, but internal historical references should retain safe non-sensitive identifiers sufficient for audit.

Relationship closure must not erase:

- agreements
- signatures
- payments
- ledger entries
- disputes
- settlements
- amendments
- audit records

---

# PHASE 46 — API DESIGN

Inspect existing route conventions first.

Implement only necessary routes.

Potential conceptual routes:

- `POST /api/relationships/invite`
- `GET /api/relationships`
- `GET /api/relationships/:id`
- `POST /api/relationships/:id/accept`
- `POST /api/relationships/:id/decline`
- `POST /api/relationships/:id/activate`
- `POST /api/relationships/:id/close`
- `GET /api/relationships/:id/accounts`
- `POST /api/relationships/:id/accounts/assign`
- `POST /api/relationships/:id/accounts/replace`

Financial-account creation may remain under existing ACH/payment routes.

Do not duplicate working APIs merely to fit this list.

Routes must be thin.

Authorization and lifecycle rules belong in services.

---

# PHASE 47 — SERVICE LAYER

Create or reuse services such as:

- `RelationshipService`
- `RelationshipInvitationService`
- `RelationshipFinancialAccountService`

only where responsibilities are not already represented.

Services should own:

- actor resolution
- party resolution
- organization capability checks
- invitation state
- relationship lifecycle
- financial ownership validation
- financial assignment validation
- activation prerequisites
- audit events
- notification calls
- idempotency
- cross-relationship isolation

Do not bury authorization in route handlers.

---

# PHASE 48 — REPOSITORY LAYER

Follow established repository pattern.

Expected separation:

Route  
→ Service  
→ Repository  
→ Database

Do not introduce ad hoc direct SQL in route handlers if repository abstractions are already standard.

---

# PHASE 49 — UI / USER WORKFLOW

Inspect the actual Sprint 18A scope and existing UI conventions.

If UI is appropriate in this sprint, implement the minimum complete user-facing workflow.

Expected concepts:

- Connections / Relationships
- Invite Counterparty
- Pending Invitations
- Relationship Details
- Add Bank Account
- Financial Accounts
- Select Funding Account
- Select Receiving Account
- Relationship Setup Progress

The user must be able to understand:

- who they are connected to
- what identity they are acting as
- why the relationship exists
- which agreement governs it
- where funds will come from
- where funds will go
- which setup steps are incomplete
- whether the relationship is active

Do not expose raw internal table terminology.

---

# PHASE 50 — COOPERATIVE SETUP EXPERIENCE

If UI is in scope, implement a cooperative setup progression.

Example:

Party A initiates  
→ Party B accepts  
→ both identities confirmed  
→ payer adds/selects funding account  
→ receiver adds/selects payout account  
→ agreement created/reviewed  
→ signatures completed  
→ server validates prerequisites  
→ relationship ACTIVE

Each party's progress must be tracked separately.

One party completing a requirement must not falsely mark the other party's requirement complete.

---

# PHASE 51 — P2P TEST SCENARIO

Create a representative integration test.

Example:

Ahmad owes Bilal $600.

- Ahmad creates invitation.
- Bilal accepts.
- relationship created.
- Ahmad is debtor/payer for the agreement.
- Bilal is creditor/receiver.
- Ahmad selects verified funding bank account.
- Bilal selects verified payout bank account.
- agreement is linked.
- both complete required signatures.
- relationship activates.
- installment/payment resolves relationship context.
- ledger entry resolves same relationship.

Then create a second relationship/agreement in which Bilal owes Ahmad and verify global account identities do not change.

---

# PHASE 52 — B2C TEST SCENARIO

Authorized Business ABC employee creates relationship with Customer Jane.

Verify:

- business capability required
- Jane accepts explicitly
- Jane uses personal funding account
- ABC uses organization payout account
- staff member's personal bank account cannot be substituted
- viewer-only business staff cannot perform binding actions
- agreement/payment/ledger all resolve organization relationship correctly

---

# PHASE 53 — B2B TEST SCENARIO

Company A ↔ Company B.

Verify:

- both principals are organizations
- both representatives are authorized
- both organizations use organization-owned financial accounts
- no personal staff financial account can be assigned
- agreement and payment context remains organizational
- unauthorized staff denied
- RLS prevents cross-company leakage

---

# PHASE 54 — REQUIRED AUTOMATED TESTS

At minimum add tests for:

## Invitation / Handshake
1. existing-user invitation
2. new-user invitation
3. invitation expiration
4. invitation cancellation
5. wrong user acceptance blocked
6. invitee acceptance
7. invitee rejection
8. repeated acceptance idempotent
9. replay token rejected
10. tampered token rejected
11. unauthorized business representative blocked
12. authorized business representative accepted
13. signup does not auto-accept invitation
14. invitation cannot directly activate relationship

## Relationship
15. Individual ↔ Individual
16. Individual ↔ Business
17. Business ↔ Individual
18. Business ↔ Business
19. same user has different roles in different relationships
20. legitimate multiple relationships between same parties
21. invalid participant combination rejected
22. invalid lifecycle transition rejected

## Financial Accounts
23. individual adds bank account
24. business adds bank account
25. unverified account blocked when verification required
26. funding assignment succeeds
27. payout assignment succeeds
28. unauthorized account assignment blocked
29. another party's account cannot be selected
30. account replacement preserves history
31. disabled account cannot be newly assigned
32. provider secret not exposed
33. masked account returned

## Activation
34. blocked when counterparty incomplete
35. blocked when agreement missing
36. blocked when signature missing
37. blocked when funding missing
38. blocked when payout missing
39. blocked when bank unverified
40. blocked when mandate missing
41. blocked when business authority missing
42. blocked when relationship restricted
43. successful activation when complete

## Cross-Sprint
44. agreement connector
45. signature connector
46. document/evidence connector
47. ACH connector
48. debit-card connector
49. payment connector
50. retry connector
51. amendment connector
52. partial-payment connector
53. settlement connector
54. dispute connector
55. notification connector
56. ledger connector
57. audit connector

## RLS / Security
58. unrelated user denied
59. unrelated organization denied
60. inactive staff denied
61. viewer-only staff denied binding operation
62. IDOR attempt blocked
63. relationship ID guessing blocked
64. funding-account substitution blocked
65. payout-account substitution blocked

Run the **complete repository test suite**, not only Sprint 18A tests.

Zero regressions are expected.

---

# PHASE 55 — MIGRATION REQUIREMENTS

Use migrations only.

Prefer additive changes.

No destructive migration without Product Owner approval.

Validate:

- foreign keys
- CHECK constraints
- unique constraints
- indexes
- enum additions
- RLS
- `REVOKE`
- migration journal
- schema snapshot
- drizzle consistency
- no schema drift

Do not manually create production-only tables through the Supabase dashboard.

---

# PHASE 56 — PERFORMANCE

Review actual query paths and add justified indexes.

Expected query categories:

- relationship by participant
- relationships by organization
- pending invitation by invitee
- invitation by secure lookup reference
- relationship financial assignments
- active financial assignment
- agreement by relationship
- active relationship filtering

Do not add speculative indexes without a query use case.

---

# PHASE 57 — SECURITY REVIEW

Before Product Owner handoff, explicitly review for:

- IDOR
- invitation hijacking
- token replay
- token leakage
- client-side role forgery
- client-side party forgery
- unauthorized organization representation
- funding-account substitution
- payout-account substitution
- relationship state forgery
- stale business authorization
- duplicate acceptance
- duplicate activation
- cross-tenant RLS leakage
- sensitive financial data in logs
- provider secrets in client responses
- hardcoded account data
- insecure admin access

Document findings.

---

# PHASE 58 — END-TO-END TRACEABILITY

Prove with tests or documented repository traces that these paths work:

`Authenticated User`
→ `Party`
→ `Relationship`
→ `Agreement`
→ `Agreement Version`
→ `Installment`
→ `Payment`
→ `Ledger`

and:

`Relationship`
→ `Signature`
→ `Document`
→ `Amendment`
→ `Settlement`
→ `Dispute`
→ `Notification`
→ `Audit`

and:

`Party`
→ `Financial Account`
→ `Relationship Account Assignment`
→ `Payment`

No new Sprint 18A records should be orphaned.

---

# PHASE 59 — SPRINT 1–20 CONNECTOR MATRIX

Create a durable documentation section/table that uses the actual repository sprint names.

For every Sprint 1–20 document:

- sprint
- component
- existing data source
- relationship connector
- direct or derived `relationship_id`
- authorization implications
- financial-account implications
- notification implications
- audit implications
- Sprint 18A code changed?
- remaining future work

Every sprint must be accounted for.

Do not omit future Sprints 18–20 merely because they are not implemented yet.

Mark future connectors explicitly as planned.

---

# PHASE 60 — DOCUMENTATION

Update:

- `docs/SPRINT_CONTROL.md`
- `docs/PROGRESS.md`
- architecture documentation where appropriate
- requirements/traceability matrix where appropriate

Document:

- relationship architecture
- handshake lifecycle
- financial-account ownership model
- financial-account assignment model
- activation prerequisites
- cross-sprint connector matrix
- security assumptions
- known limitations
- future sprint ownership

Do not claim unsupported functionality exists.

---

# PRODUCT OWNER HANDOFF GATE

When Sprint 18A implementation is complete:

Do **not** commit.

Do **not** push.

Do **not** merge.

Do **not** deploy.

Do **not** begin Sprint 18.

Stop and provide this exact structured report:

# Sprint 18A Completion Report

## Architecture Discovery
- master branch/commit used
- actual Sprint 1–20 specifications discovered
- existing relationship-like structures discovered
- implicit relationship paths discovered
- duplicate party/role patterns discovered
- existing financial-account architecture
- existing agreement/payment/ledger connector architecture
- architectural gaps identified

## Implementation
- branch/worktree
- files created
- files modified
- services created/modified
- routes created/modified
- repository changes
- UI changes

## Database
- migration filename
- new tables
- modified tables
- new columns
- foreign keys
- CHECK constraints
- unique constraints
- indexes
- enum changes
- RLS policies
- REVOKE status
- migration/drizzle result

## Cooperative Handshake
- invitation lifecycle
- existing-user flow
- new-user flow
- business flow
- identity selection
- token protection
- replay protection
- idempotency
- relationship creation behavior

## Financial Accounts
- add-bank-account flow
- provider/tokenization boundary
- verification flow
- individual ownership
- organization ownership
- funding assignment
- payout assignment
- account replacement
- sensitive-data handling

## Relationship Architecture
- participant model
- role model
- lifecycle state machine
- activation gate
- restriction behavior
- closure behavior
- historical preservation

## Cross-Sprint Integration
For each actual Sprint 1–20 report:
- connector
- data path
- authorization impact
- tests
- future dependency if applicable

## Security Review
- IDOR
- token security
- cross-tenant isolation
- business capabilities
- financial-account substitution
- provider-secret handling
- logging
- admin access
- RLS

## Tests
- tests added
- total tests passing
- total test files
- regressions
- failed tests if any

## Validation
- `npm run typecheck`
- lint
- production build
- drizzle/schema validation
- migration status
- schema drift
- git status

## Known Limitations
List every known limitation.

For each limitation identify:
- why it remains
- whether it is intentionally out of Sprint 18A scope
- exact future sprint or architecture owner

## Acceptance Criteria
Explicit PASS/FAIL for every Sprint 18A requirement.

Then state:

**Awaiting ChatGPT/Product Owner Sprint 18A architecture and implementation review. I will not commit, push, merge, deploy, or begin Sprint 18.**