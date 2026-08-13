# Sprint 18A — Cooperative Account Pairing, Financial Account Linking & Relationship Architecture

## Authority and Execution Rules

Begin Sprint 18A only.

Before writing code, read and reconcile:

* `PAY2PAY_MASTER_SPEC.md`
* `CLAUDE.md`
* `docs/SPRINT_CONTROL.md`
* every completed Sprint 1–17 specification
* planned Sprint 18–20 specifications
* current database schema
* current migrations
* current RLS policies
* current payment-provider abstractions
* current agreement/payment/ledger/dispute/notification services

The repository and `PAY2PAY_MASTER_SPEC.md` are authoritative.

Do not infer architecture from this instruction where the repository already defines a compatible authoritative structure.

If this Sprint 18A instruction conflicts with an established security, ledger, payment-provider, agreement-versioning, or audit invariant, stop and report the conflict before changing production architecture.

Create a dedicated isolated branch/worktree for Sprint 18A from synchronized `origin/master`.

Do not modify unrelated pre-existing files in the main checkout.

Do not begin Sprint 18 or any later sprint.

---

# 1. Sprint 18A Purpose

Sprint 18A creates the platform-wide **Relationship Architecture** connecting:

1. authenticated users;
2. individual profiles;
3. organizations/businesses;
4. business staff and capabilities;
5. counterparties;
6. invitations;
7. cooperative account pairing;
8. relationship roles;
9. financial accounts;
10. funding methods;
11. receiving/payout accounts;
12. agreements;
13. agreement versions;
14. signatures;
15. evidence/documents;
16. installments;
17. ACH payments;
18. debit-card payments;
19. payment retries;
20. amendments/hardship arrangements;
21. partial payments;
22. settlements;
23. disputes;
24. notifications;
25. ledger records;
26. audit records;
27. administrative review;
28. future fraud/compliance/security controls;
29. closed-beta operational controls;
30. production-readiness controls.

The central architectural concept is:

**Accounts belong to users or organizations.**

**Payment roles belong to relationships.**

A platform account must never be permanently classified as:

* borrower;
* lender;
* payer;
* receiver;
* creditor;
* debtor.

Those are contextual relationship roles.

One person may simultaneously:

* owe Person A;
* receive repayment from Person B;
* represent Business C;
* collect money on behalf of Business C;
* make payments to Business D.

The architecture must support all of those concurrently.

---

# 2. Canonical Architecture

The target logical architecture is:

```text
AUTH USER
   │
   ├── Individual Profile
   │
   └── Organization Membership
             │
             └── Organization
                    │
                    └── Organization Financial Accounts

AUTH USER / ORGANIZATION
           │
           ▼
    PARTY / ACTOR MODEL
           │
           ▼
    RELATIONSHIP INVITATION
           │
           ▼
     COUNTERPARTY HANDSHAKE
           │
           ▼
    PAYMENT RELATIONSHIP
       │           │
       │           └──────────── Relationship Participants
       │
       ├── Financial Account Authorizations
       │       ├── Funding Account
       │       └── Receiving/Payout Account
       │
       ├── Agreement
       │       ├── Agreement Versions
       │       ├── Signatures
       │       ├── Evidence/Documents
       │       ├── Amendments
       │       ├── Hardship
       │       └── Settlements
       │
       ├── Installments
       │
       ├── Payments
       │       ├── ACH
       │       ├── Debit Card
       │       ├── Retry
       │       ├── Partial Payments
       │       └── Payment Disputes
       │
       ├── Ledger
       │
       ├── Agreement Disputes
       │
       ├── Notifications
       │
       └── Audit Trail
```

Do not implement a duplicate copy of a component already present.

Sprint 18A should add the missing connective layer.

---

# 3. Party Abstraction

Before implementing relationship logic, inspect whether the repository already has a generic party/actor abstraction.

If not, create an internal conceptual abstraction capable of referencing either:

```text
INDIVIDUAL
ORGANIZATION
```

Do not force organization relationships through an individual user ID.

Do not create polymorphism that defeats referential integrity unless the existing project architecture already uses that pattern.

Preferred design should permit explicit references such as:

* individual_profile_id
* organization_id

with strong CHECK constraints ensuring exactly one party target where required.

Alternative normalized party architecture may be used if already supported by the repository.

The implementation must allow:

```text
Individual ↔ Individual
Individual ↔ Organization
Organization ↔ Individual
Organization ↔ Organization
```

without special-case tables for each combination.

---

# 4. Relationship Identifier

Introduce or identify the canonical relationship identifier.

Conceptual prefix:

`REL`

Example:

`REL_01J...`

Do not rename existing mature identifiers simply for cosmetic consistency.

Every financially meaningful operation introduced after Sprint 18A should be capable of tracing back to:

```text
relationship_id
```

either directly or through an immutable parent chain.

---

# 5. Cooperative User Account Handshake

This is a critical Sprint 18A requirement.

A relationship may not become active because one party simply enters another person's email address.

The relationship must use a **two-sided cooperative handshake**.

The handshake establishes:

1. who initiated;
2. who was invited;
3. which platform party each side represents;
4. whether the invited party accepts;
5. relationship role expectations;
6. whether a business representative has authority;
7. whether both sides agree to establish the relationship;
8. which financial accounts are authorized;
9. which agreement governs the relationship.

---

# 6. Invitation Lifecycle

Implement an explicit invitation state machine.

Conceptual states:

```text
DRAFT
SENT
DELIVERED
VIEWED
ACCEPTED
DECLINED
EXPIRED
CANCELLED
SUPERSEDED
```

Use existing enum conventions if present.

Invitation must record at minimum:

* invitation_id;
* inviter user;
* inviter represented party;
* invitee locator;
* resolved invitee user when known;
* resolved invitee represented party when known;
* intended relationship purpose;
* proposed directional roles;
* invitation token reference/hash;
* created_at;
* expires_at;
* accepted_at;
* declined_at;
* cancelled_at;
* status;
* correlation ID;
* audit metadata.

Never store a reusable plaintext invitation secret.

Invitation tokens must be cryptographically secure.

Store only the protected representation required by the existing token-verification architecture.

---

# 7. Existing User Invitation

If the invited email/phone/account maps to an existing authenticated account:

1. create invitation;
2. notify recipient;
3. recipient authenticates;
4. recipient views invitation;
5. system resolves recipient's eligible Individual/Organization identities;
6. recipient selects which identity they are acting as;
7. server validates authority;
8. recipient accepts or rejects;
9. successful acceptance creates or activates the relationship participant linkage;
10. audit event is created.

A logged-in User B must not be able to accept an invitation intended for User C.

---

# 8. New User Invitation

If the invitee does not yet have an account:

1. Party A creates invitation.
2. System creates pending invitation only.
3. Invitee receives enrollment link.
4. Invitee creates/authenticates account using Sprint 2 authentication.
5. Account verification completes.
6. System resolves invitation after authentication.
7. Invitee selects/creates eligible Individual or Business identity.
8. Invitee reviews relationship request.
9. Invitee explicitly accepts.
10. Relationship linkage is created.
11. Invitation becomes ACCEPTED.

Account signup itself must **not** automatically accept a financial relationship.

---

# 9. Business Handshake

Business participation must integrate with Sprint 4 business permissions/capabilities.

When a user acts for an organization, verify:

* membership is active;
* organization is active;
* relevant capability exists;
* user has authority to invite or accept counterparties;
* user has authority to attach/change financial accounts;
* user has authority to accept financially binding relationship actions.

Do not treat organization membership alone as sufficient authority.

Use existing capability gates wherever available.

---

# 10. Relationship Participants

A relationship must support exactly or at least the participant cardinality defined by the master specification.

For the current two-party repayment model, enforce two principal counterparties unless existing architecture explicitly supports more.

Suggested conceptual table:

```text
relationship_participant
```

Fields should include:

* relationship_participant_id
* relationship_id
* individual_profile_id nullable
* organization_id nullable
* role
* payment_direction
* status
* joined_at
* left_at nullable
* represented_by_user_id when applicable
* created_at
* updated_at

Enforce exactly one of:

```text
individual_profile_id
organization_id
```

for the principal party reference.

---

# 11. Relationship-Specific Roles

Roles may include concepts such as:

```text
OBLIGOR
OBLIGEE
PAYER
RECEIVER
BOTH
```

However, do not create redundant role taxonomy if the existing agreement architecture already uses:

```text
debtor
creditor
```

Map existing semantics rather than creating competing terminology.

The crucial rule is that role is scoped to:

```text
relationship_id
```

not the global user.

---

# 12. Bidirectional Capability

The relationship model must not assume money can only ever move one direction forever.

Architecture must permit, where agreement rules allow:

```text
A → B
B → A
```

without creating a new user account.

If the current agreement model allows only one repayment direction per agreement, preserve that invariant.

In that case:

```text
Relationship
    ├── Agreement 1: A pays B
    └── Agreement 2: B pays A
```

may be preferable to corrupting the agreement model.

Determine the correct structure from the existing agreement engine.

---

# 13. Relationship State Machine

Implement a formal relationship lifecycle.

Conceptual lifecycle:

```text
INVITED
    ↓
COUNTERPARTY_LINKED
    ↓
IDENTITIES_CONFIRMED
    ↓
FINANCIAL_SETUP_PENDING
    ↓
FINANCIAL_ACCOUNTS_READY
    ↓
AGREEMENT_PENDING
    ↓
AGREEMENT_READY
    ↓
SIGNATURE_PENDING
    ↓
SIGNED
    ↓
ACTIVE
```

Additional states may include:

```text
RESTRICTED
SUSPENDED
DISPUTED
CLOSED
CANCELLED
ARCHIVED
```

Transitions must occur server-side.

No client may arbitrarily set relationship state.

Create transition validation.

Invalid transitions must fail closed.

---

# 14. Activation Gate

A relationship may not become ACTIVE unless required prerequisites are satisfied.

Depending on relationship/payment type, validate:

* both counterparties linked;
* identities verified as required;
* business representative authority valid;
* agreement exists;
* correct agreement version selected;
* required signatures exist;
* funding account is authorized;
* payout/receiving account is authorized;
* payment mandate exists if required;
* relationship is not restricted;
* no blocking dispute exists;
* any required step-up authorization has occurred;
* account status is eligible.

Activation should be handled by a service-level invariant, not merely UI state.

---

# 15. Financial Account Architecture

Users and organizations must be able to add financial account information.

Sprint 18A must expose a complete account-linking architecture while respecting the tokenized payment-provider architecture already built.

Financial accounts may include, where supported:

```text
BANK_ACCOUNT
DEBIT_CARD
```

Do not store full PAN, CVV, or plaintext bank account/routing credentials unless the existing sandbox architecture explicitly requires fake sandbox values and production storage is impossible.

Production architecture must assume tokenization/provider references.

---

# 16. Bank Account Addition Flow

Implement or connect the following bank-account flow:

```text
User/Business
   ↓
Add Bank Account
   ↓
Provider/tokenization boundary
   ↓
Verification
   ↓
Financial Account record
   ↓
Ownership/authorization association
   ↓
Relationship account assignment
```

Financial account record should conceptually include:

* financial_account_id
* owner individual or organization
* payment provider
* provider account/token reference
* account type
* bank account subtype
* masked account digits
* institution display name if available
* verification status
* ownership status
* funding eligibility
* receiving eligibility
* mandate status
* active/inactive status
* created_at
* verified_at
* disabled_at

Do not expose provider secrets to the browser.

---

# 17. Bank Account Verification

Reuse existing ACH/payment-provider abstractions.

Do not invent a second ACH system.

Support the repository's chosen verification mechanism.

Examples may include:

* provider instant verification;
* micro-deposit verification;
* sandbox verification.

The relationship layer only consumes:

```text
VERIFIED / NOT VERIFIED / PENDING / FAILED
```

or the existing authoritative equivalent.

---

# 18. Financial Account Ownership

Financial accounts belong to a party, not directly to a relationship.

Correct structure:

```text
Party
  └── Financial Account
          │
          └── Relationship Financial Account Assignment
```

Do not make the same bank account record belong permanently to one agreement.

A party may reuse an eligible verified account across multiple authorized relationships.

---

# 19. Relationship Financial Account Assignment

Create or identify a relationship-scoped association.

Conceptually:

```text
relationship_financial_account
```

It should record:

* relationship_id;
* financial_account_id;
* participant_id;
* usage type;
* funding/payout direction;
* authorization status;
* effective_from;
* effective_to;
* selected_at;
* selected_by;
* replaced_by;
* audit metadata.

Usage types may include:

```text
FUNDING
PAYOUT
BOTH
```

Only permit `BOTH` when the underlying account/provider supports it.

---

# 20. Account Change Handshake

Changing a relationship's active financial account is a material financial event.

Do not simply overwrite:

```text
relationship.funding_account_id
```

without history.

Instead:

1. create new assignment;
2. validate ownership;
3. validate verification;
4. validate authorization;
5. close/supersede prior assignment;
6. activate new assignment;
7. generate audit event.

If counterparty consent is required under the agreement/master spec, enforce it.

---

# 21. Receiving Account Connection

The receiving party must be capable of providing an authorized payout destination.

The system must distinguish:

```text
where money is pulled from
```

from:

```text
where money is delivered
```

Do not assume these are the same account or even the same payment rail.

---

# 22. Debit Card Integration

Reuse Sprint 12 debit-card sandbox architecture.

Relationship must be able to reference eligible debit-card funding methods.

Do not create separate card storage.

Maintain existing tokenized card/provider abstraction.

A debit card should normally be treated as funding unless the provider architecture explicitly supports payouts to card.

---

# 23. ACH Integration

Reuse Sprint 11 ACH architecture.

Relationship financial assignment must connect to:

* existing ACH account/token;
* mandate;
* account verification;
* payment-provider abstraction.

Do not bypass existing ACH mandate rules.

---

# 24. Payment Provider Integration

The relationship layer must not know processor-specific implementation details.

Expected logical boundary:

```text
RelationshipService
      ↓
Payment orchestration
      ↓
PaymentProvider abstraction
      ↓
ACH / Debit provider implementation
```

Relationship architecture identifies:

* who;
* which agreement;
* which accounts;
* which direction.

Payment provider architecture executes movement.

---

# 25. Agreement Connector

Every agreement must be capable of resolving its relationship.

Add:

```text
relationship_id
```

to the agreement linkage if equivalent linkage does not already exist.

Do not rewrite historical agreements.

For existing records, determine migration/backfill strategy suitable for development/test data.

Do not create invalid production assumptions.

---

# 26. Agreement Version Connector

The relationship must resolve:

* original agreement;
* active/current agreement version;
* previous immutable versions.

Sprint 18A must not replace the Sprint 5 agreement-version lifecycle.

It only provides relationship context.

---

# 27. Electronic Signature Connector

Integrate Sprint 6 signature/evidence model.

Relationship views must be capable of resolving signatures associated with the governing agreement/version.

Do not create duplicate signature rows for relationship activation.

Relationship activation may consume signature status.

Signature system remains authoritative.

---

# 28. Evidence and Document Connector

Connect Sprint 7 evidence/document architecture.

Relationship should enable scoped retrieval of:

* agreement PDFs;
* signature evidence;
* supporting documents;
* dispute evidence;
* amendment documents;
* settlement records.

Access must flow through participant/organization authorization.

---

# 29. B2B Connector

Integrate Sprint 8 B2B architecture.

Businesses must be able to establish relationships with:

* individuals;
* other businesses.

Bulk/CSV onboarding must not bypass the cooperative handshake.

Bulk imports may create:

```text
PENDING invitations
```

but must not create ACTIVE financial relationships without required counterparty consent.

---

# 30. Payment Connector

Every payment should ultimately be traceable to:

```text
relationship_id
agreement_id
payment_id
payer participant
receiver participant
funding account assignment
receiving account assignment
payment method
processor reference
```

Do not trust client-supplied versions of these identifiers when they can be derived server-side.

---

# 31. Installment Connector

Scheduled installments must resolve relationship context.

Do not duplicate installment schedules.

Add relationship linkage directly or derive through agreement when sufficient and performant.

Choose the architecture that preserves referential integrity and avoids redundant inconsistent state.

---

# 32. Ledger Connector

The ledger remains the financial source of truth established by prior sprints.

Sprint 18A must **not** introduce a second balance system.

Every ledger event must be traceable to the relationship through:

```text
payment → agreement → relationship
```

or another deterministic immutable path.

If direct `relationship_id` on ledger entries materially improves integrity/querying and is safe, document the rationale before adding it.

---

# 33. Failed Payment / Retry Connector

Sprint 13 retry operations must preserve relationship context.

Retries may not accidentally switch:

* payer;
* receiver;
* funding account;
* payout account;
* agreement;
* installment;

unless an explicitly authorized change occurred.

---

# 34. Amendment / Hardship Connector

Sprint 14 amendments belong to the governing agreement within the relationship.

A relationship must expose the current effective agreement version after amendment acceptance.

Do not mutate original agreement records.

---

# 35. Partial Payment Connector

Sprint 15 partial payments must preserve relationship attribution.

A partial payment cannot be attached to another relationship merely because the same two users are parties to both.

Always resolve the specific:

```text
relationship + agreement + obligation
```

context.

---

# 36. Settlement Connector

Settlement lifecycle remains governed by Sprint 15.

Sprint 18A must ensure settlement proposals resolve the correct relationship.

Accepted settlement is still not equivalent to completed payment.

Do not change that invariant.

---

# 37. Dispute Connector

Sprint 16 disputes must resolve relationship context.

Relationship state may become:

```text
RESTRICTED
```

or equivalent where the existing dispute architecture requires restrictions.

Do not silently block payment execution merely by UI state.

Any payment restriction must be enforced server-side in the authoritative payment execution path when required.

---

# 38. Notification Connector

Sprint 17 notifications must consume relationship events.

Examples:

* relationship_invited;
* relationship_viewed;
* relationship_accepted;
* relationship_declined;
* financial_account_required;
* financial_account_verified;
* financial_account_failed;
* relationship_ready_for_agreement;
* agreement_ready_for_signature;
* relationship_activated;
* account_changed;
* relationship_restricted;
* relationship_closed.

Reuse `NotificationService`.

Do not introduce a separate notification framework.

---

# 39. Administrative Connector

Platform Owner/Admin functionality must be capable of viewing relationship state for support and audit purposes.

Admin views must expose:

* relationship ID;
* participants;
* represented organizations;
* lifecycle state;
* agreement linkage;
* financial account status using masked metadata only;
* payment status;
* dispute status;
* audit history.

Admins must not be shown:

* full account numbers;
* CVV;
* unmasked debit-card information;
* provider secrets.

Admin access must itself be audited.

---

# 40. Fraud/Security Connector

Sprint 18A should create integration hooks for later fraud/security controls.

Examples:

* excessive invitation attempts;
* repeated account-link failures;
* multiple users attempting to claim same external account;
* unusual relationship creation velocity;
* unauthorized organization representation;
* repeated counterparty changes;
* financial account replacement immediately before payment.

Do not build a full fraud engine unless Sprint 18A repository dependencies require it.

Create reliable audit/event surfaces for later controls.

---

# 41. Relationship Ownership Rules

No relationship has a single "owner" in the consumer sense.

Both counterparties are principals.

The creator is:

```text
initiator
```

not absolute owner.

One party must not be able to:

* remove the other principal;
* impersonate the other;
* change the other party's financial account;
* accept on the other's behalf;
* change signed agreement terms unilaterally;
* transfer the relationship to another account.

---

# 42. Cooperative Handshake Security

All material cooperative actions require server-side authorization.

Examples:

```text
INVITE
ACCEPT_INVITATION
DECLINE_INVITATION
SELECT_REPRESENTED_ORGANIZATION
ASSIGN_FINANCIAL_ACCOUNT
CHANGE_FINANCIAL_ACCOUNT
ACTIVATE_RELATIONSHIP
CLOSE_RELATIONSHIP
```

Each operation must determine the acting party from the authenticated session.

Never accept:

```text
acting_user_id
acting_organization_id
```

from the browser as authoritative without verification.

---

# 43. Idempotency

Invitation acceptance and relationship activation must be idempotent.

Repeated clicks/network retries must not create:

* duplicate relationships;
* duplicate participants;
* duplicate financial assignments;
* duplicate audit records where semantic duplication is harmful;
* duplicate agreements.

Use existing idempotency/correlation conventions.

---

# 44. Duplicate Relationship Rules

Do not blindly prohibit the same two counterparties from having multiple relationships.

They may legitimately have:

* multiple loans;
* personal and business arrangements;
* separate agreements;
* different payment purposes.

Instead define duplicate prevention around idempotent creation attempts.

Relationship uniqueness should not accidentally prevent legitimate multiple agreements.

---

# 45. Privacy Boundaries

Before relationship acceptance:

The inviter should only see the minimum identity information necessary to confirm the intended counterparty.

After relationship acceptance:

Each participant may see only information authorized by the relationship and agreement.

Never reveal:

* unrelated relationships;
* unrelated financial accounts;
* full financial credentials;
* other organization memberships;
* internal fraud flags;
* administrator-only information.

---

# 46. RLS Architecture

New relationship tables must use RLS.

RLS must cover:

* individual participant access;
* organization participant access;
* authorized organization staff;
* administrator access where appropriate;
* service/server execution paths.

Test:

```text
User A cannot read User C/D relationship.
Business A staff cannot read Business B relationship.
Former staff cannot access organization relationships.
Viewer-only staff cannot perform binding financial actions.
```

Never rely solely on service-layer filtering.

---

# 47. Database Constraints

Use database constraints for invariants wherever possible.

Examples:

* exactly one party target;
* valid relationship state;
* valid participant state;
* financial account belongs to participant;
* no duplicate active assignment for same usage slot where prohibited;
* accepted invitation maps only once;
* relationship cannot reference itself as both distinct counterparties;
* timestamps consistent with lifecycle state.

---

# 48. Audit Architecture

Every material operation must generate audit history.

At minimum:

```text
RELATIONSHIP_INVITATION_CREATED
RELATIONSHIP_INVITATION_SENT
RELATIONSHIP_INVITATION_VIEWED
RELATIONSHIP_INVITATION_ACCEPTED
RELATIONSHIP_INVITATION_DECLINED
RELATIONSHIP_INVITATION_EXPIRED
RELATIONSHIP_CREATED
RELATIONSHIP_PARTICIPANT_LINKED
RELATIONSHIP_ROLE_CONFIRMED
FINANCIAL_ACCOUNT_ADDED
FINANCIAL_ACCOUNT_VERIFIED
FINANCIAL_ACCOUNT_ASSIGNMENT_CREATED
FINANCIAL_ACCOUNT_ASSIGNMENT_REPLACED
AGREEMENT_LINKED
RELATIONSHIP_SIGNED
RELATIONSHIP_ACTIVATED
RELATIONSHIP_RESTRICTED
RELATIONSHIP_SUSPENDED
RELATIONSHIP_CLOSED
```

Use existing audit infrastructure.

Do not create a parallel audit table unless technically required.

---

# 49. Relationship Event Architecture

Prefer domain events so later systems can consume relationship changes.

Conceptually:

```text
RelationshipInvited
RelationshipAccepted
FinancialAccountAssigned
AgreementAttached
RelationshipActivated
RelationshipRestricted
RelationshipClosed
```

Events may feed:

* notification system;
* audit system;
* fraud monitoring;
* future compliance checks.

Do not create uncontrolled asynchronous behavior if the repository has no event architecture.

Use existing service/event patterns.

---

# 50. API Layer

Implement routes consistent with existing Next.js API conventions.

Potential routes, subject to repository conventions:

```text
POST /api/relationships/invite
GET  /api/relationships
GET  /api/relationships/:id
POST /api/relationships/:id/accept
POST /api/relationships/:id/decline

GET  /api/relationships/:id/accounts
POST /api/relationships/:id/accounts/assign
POST /api/relationships/:id/accounts/replace

POST /api/relationships/:id/activate
POST /api/relationships/:id/close
```

Bank accounts may use existing financial-account routes rather than new relationship routes.

Do not duplicate existing APIs.

---

# 51. Service Layer

Introduce or identify:

```text
RelationshipService
RelationshipInvitationService
RelationshipFinancialAccountService
```

Only if these responsibilities are not already represented.

The service layer should enforce:

* transitions;
* actor resolution;
* organization capabilities;
* account ownership;
* invitation authority;
* activation prerequisites;
* cross-relationship isolation;
* audit hooks.

Controllers/routes should remain thin.

---

# 52. Repository Layer

Use repository interfaces consistent with existing Sprint architecture.

Do not allow application services to perform ad hoc SQL if repository abstraction is already standard throughout the project.

Expected responsibility separation:

```text
Route
  ↓
Service
  ↓
Repository
  ↓
Database
```

---

# 53. Front-End/UI Scope

If Sprint 18A includes UI under the master specification, create a minimal but complete workflow.

Required conceptual screens:

```text
Connections / Relationships
Invite Counterparty
Pending Invitations
Relationship Details
Financial Accounts
Add Bank Account
Select Funding Account
Select Receiving Account
Relationship Setup Progress
```

Users should be able to understand:

```text
Who am I connected to?
Why are we connected?
What agreement governs this?
Which account will I pay from?
Which account will receive funds?
Is setup complete?
What is still required?
```

Do not expose internal database terminology.

---

# 54. Cooperative Setup Wizard

If UI is in scope, relationship setup should function as a cooperative wizard.

Example:

```text
PARTY A
Creates connection
    ↓
PARTY B
Accepts connection
    ↓
BOTH PARTIES
Identity/authority confirmed
    ↓
PAYER
Adds/selects funding account
    ↓
RECEIVER
Adds/selects receiving account
    ↓
AGREEMENT
Created/reviewed
    ↓
BOTH
Sign
    ↓
SYSTEM
Validates prerequisites
    ↓
RELATIONSHIP ACTIVE
```

The wizard must display progress independently to both parties.

One party completing their own requirement must not falsely show the other party's requirement complete.

---

# 55. Handshake Example — P2P

Example:

Ahmad owes Bilal $600.

```text
Ahmad creates relationship invitation.
Bilal receives invitation.
Bilal logs in.
Bilal accepts.
REL created.

Ahmad role:
payer/debtor for AGR-001

Bilal role:
receiver/creditor for AGR-001

Ahmad selects verified bank account:
FIN-A

Bilal selects verified payout account:
FIN-B

Agreement AGR-001 created.
Both sign.
Relationship becomes ACTIVE.

Installments and payments inherit REL context.
```

Later, Bilal may owe Ahmad under a separate agreement.

Do not change their global account types.

---

# 56. Handshake Example — B2C

Business ABC collects repayment from Customer Jane.

```text
Authorized ABC staff initiates invitation.
System verifies staff capability.
Jane accepts.
REL created:
ABC ↔ Jane

Jane selects funding account.
ABC selects organization receiving account.

Agreement created.
Jane signs.
Authorized ABC representative signs if required.

REL becomes ACTIVE.
```

A random ABC employee must not be allowed to:

* change payout account;
* accept binding agreement modifications;
* create settlements;

unless their Sprint 4 capability grants it.

---

# 57. Handshake Example — B2B

Company A owes Company B.

Both sides must select organization identities.

Authorized representatives participate.

Relationship:

```text
ORG-A
  ↕
REL
  ↕
ORG-B
```

Financial accounts remain owned by their respective organizations.

Payments must not route through the staff member's personal account.

---

# 58. Relationship to Sprints 1–20

Sprint 18A must document explicit connector ownership for the entire roadmap.

At minimum, produce a matrix covering every Sprint 1–20 with:

```text
Sprint
Existing component
Relationship dependency
Connector implemented in 18A
Data linkage
Authorization impact
Regression tests
Future work
```

Do not guess sprint titles.

Read the actual sprint files.

The matrix must use the repository's real sprint numbering and names.

---

# 59. Sprint Connector Audit

Before implementation, produce an internal connector inventory answering:

```text
What tables already exist?
What IDs currently connect them?
Where are relationships implicit?
Where is party identity duplicated?
Where are payer/receiver IDs stored independently?
Where are bank account references stored?
Where are agreement IDs stored?
Where are payment IDs stored?
Where are ledger correlations stored?
Where do notifications resolve recipients?
Where do disputes identify principals?
```

Then identify the minimum additive changes required.

Do not refactor the entire platform merely for aesthetic consistency.

---

# 60. Referential Integrity Audit

After implementation verify a complete trace can be performed:

```text
User
→ Party
→ Relationship
→ Agreement
→ Agreement Version
→ Installment
→ Payment
→ Ledger
```

and:

```text
Relationship
→ Amendment
→ Settlement
→ Dispute
→ Notification
→ Audit
```

and:

```text
Party
→ Financial Account
→ Relationship Assignment
→ Payment
```

There must be no orphan path for new records introduced by Sprint 18A.

---

# 61. Deletion Rules

Do not hard-delete financially significant relationship history.

Determine appropriate strategy:

```text
inactive
closed
revoked
archived
superseded
```

Financial account credentials may require provider-side deletion/revocation, but internal audit references should retain non-sensitive identifiers necessary for historical integrity.

---

# 62. Relationship Closure

Closing a relationship must not erase:

* signed agreements;
* ledger entries;
* payment history;
* settlement history;
* dispute history;
* audit history.

Closure must prevent new activity according to existing lifecycle rules.

---

# 63. Testing — Cooperative Handshake

Add automated tests for:

1. existing-user invitation;
2. new-user invitation;
3. invitation expiration;
4. invitation cancellation;
5. wrong user attempts acceptance;
6. invitee accepts;
7. invitee declines;
8. duplicate acceptance;
9. replayed token;
10. tampered token;
11. organization representative acceptance;
12. unauthorized organization staff acceptance;
13. invitation cannot activate relationship automatically;
14. accepted invitation creates correct participants;
15. opposite relationship roles supported.

---

# 64. Testing — Financial Accounts

Test:

1. individual adds verified bank account;
2. business adds verified bank account;
3. unauthorized user attempts account association;
4. unverified account cannot be used when verification required;
5. payer assigns funding account;
6. receiver assigns payout account;
7. one party cannot select the other party's account;
8. account replacement preserves history;
9. disabled account cannot fund new payment;
10. unrelated relationship cannot access account;
11. masked account data returned to UI;
12. provider secret never returned to UI.

---

# 65. Testing — Relationship Activation

Test activation blocked when:

* counterparty missing;
* invitation not accepted;
* agreement missing;
* signature missing;
* funding account missing;
* payout account missing;
* financial account unverified;
* organization authority missing;
* relationship restricted;
* required mandate missing.

Test successful activation when all prerequisites are satisfied.

---

# 66. Testing — Cross-Sprint Integration

Test relationship integration with:

* authentication;
* profile;
* organization permissions;
* agreement;
* signatures;
* documents;
* B2B;
* ACH;
* debit card;
* retry;
* amendments;
* partial payment;
* settlement;
* dispute;
* notifications;
* ledger;
* audit.

Tests should prove the relationship layer connects existing functionality rather than duplicating it.

---

# 67. Testing — Isolation

Create at least:

```text
User A
User B
User C
Business X
Business Y
```

Relationships:

```text
A ↔ B
A ↔ Business X
Business X ↔ Business Y
```

Verify User C cannot access any.

Verify Business Y staff cannot inspect A ↔ B.

Verify Business X viewer-only staff cannot perform binding actions.

---

# 68. Migration Requirements

All migrations must be additive where practical.

No destructive migration without explicit Product Owner approval.

Migration review must verify:

* foreign keys;
* indexes;
* unique constraints;
* CHECK constraints;
* enum compatibility;
* RLS;
* `REVOKE`;
* migration journal;
* schema snapshot;
* no drift.

---

# 69. Performance Requirements

Add indexes for expected relationship access patterns:

```text
relationship participant lookup
pending invitations
party relationships
relationship financial accounts
agreement relationship lookup
active relationship filtering
organization relationship lookup
```

Do not add indexes blindly.

Use query patterns from actual services.

---

# 70. Security Requirements

Explicitly protect against:

* IDOR;
* invitation hijacking;
* token replay;
* cross-tenant access;
* unauthorized organization representation;
* funding-account substitution;
* payout-account substitution;
* relationship ID guessing;
* client-side role forgery;
* client-side state-transition forgery;
* duplicate activation;
* hidden-field manipulation;
* stale authorization after staff role revocation.

---

# 71. Logging

Never log:

* full bank account numbers;
* routing numbers unless existing security policy explicitly permits masked format;
* card PAN;
* CVV;
* provider secrets;
* invitation secrets;
* authentication tokens.

Logs may include:

* relationship ID;
* financial account ID;
* masked suffix;
* provider event ID;
* correlation ID.

---

# 72. Definition of Done

Sprint 18A is not complete merely because a `relationship` table exists.

It is complete only when:

1. two counterparties can cooperatively pair;
2. invitation acceptance is authenticated;
3. individual and business identities are supported;
4. organization authority is enforced;
5. each party can own financial accounts;
6. bank accounts can be added through the existing payment architecture;
7. verified accounts can be assigned to a relationship;
8. payer funding and receiver payout are distinct concepts;
9. agreement linkage exists;
10. signature linkage exists;
11. payment linkage exists;
12. ledger traceability exists;
13. dispute linkage exists;
14. amendment/settlement linkage exists;
15. notification integration exists;
16. audit integration exists;
17. RLS isolation is tested;
18. lifecycle transitions are enforced server-side;
19. relationship activation prerequisites are enforced;
20. Sprints 1–20 connector matrix is documented;
21. full regression suite passes.

---

# 73. Product Owner Completion Report

At completion stop and provide:

## Architecture Review

* existing architecture discovered;
* implicit relationships found;
* duplicated identity/role patterns found;
* connector gaps found;
* design decisions made.

## Database

* tables created;
* tables modified;
* columns added;
* foreign keys;
* indexes;
* constraints;
* enums;
* RLS policies;
* migration filename;
* schema/drizzle status.

## Cooperative Handshake

* invitation lifecycle;
* existing-user flow;
* new-user flow;
* business flow;
* invitation security;
* replay protection;
* idempotency.

## Financial Accounts

* bank-account creation flow;
* verification flow;
* tokenization/provider boundary;
* funding-account assignment;
* payout-account assignment;
* account replacement;
* authorization.

## Relationship Architecture

* participant model;
* role model;
* lifecycle;
* activation gate;
* relationship closure;
* historical preservation.

## Cross-Sprint Connectors

Report the relationship connector for every actual Sprint 1–20.

Do not omit a sprint.

## Security

* authorization;
* organization capability checks;
* RLS;
* IDOR protections;
* financial-data handling;
* secret/token protections.

## Validation

* tests added;
* total tests passing;
* regressions;
* type-check;
* lint;
* production build;
* migration check;
* schema drift;
* git status.

## Known Limitations

List every known architectural or implementation limitation.

Do not classify a limitation as future work without identifying which existing or planned sprint owns it.

## Final State

Do not commit.
Do not push.
Do not merge.
Do not begin Sprint 18.

State:

**Awaiting ChatGPT/Product Owner Sprint 18A architecture and implementation review. I will not begin Sprint 18.**
