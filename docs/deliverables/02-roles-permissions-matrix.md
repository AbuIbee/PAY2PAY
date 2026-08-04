# Deliverable 2: User Roles and Permissions Matrix

Source: `docs/PAY2PAY_MASTER_SPEC.md`, primarily Sections 16, 17, 18, 18A, 20, 26, 29, 30.
Roles listed are exactly the eleven named in Section 36, Deliverable 2. Where the spec does not
fully specify a role's boundaries, that gap is stated explicitly and carried to `docs/OPEN_DECISIONS.md`
rather than resolved by invention.

## 1. Role model overview

PAY2PAY has four different *kinds* of role, which is why "role" alone is ambiguous and the spec
lists eleven distinct entries:

1. **Base identity roles** — what a person or business *is* on the platform: **Personal user**,
   **Business owner** (of a verified business profile). These carry a verification tier (Section 17)
   that gates what the identity is allowed to do.
2. **Agreement-scoped roles** — assigned *per agreement*, not permanently to the person:
   **Borrower**, **Personal creditor** (and their business equivalents). Per Section 18, "a user may
   be a borrower on one agreement and a creditor on another. Roles are defined per agreement." A
   Business profile acting as creditor or debtor in a B2B agreement is represented through its
   **authorized representative** (Section 18A), not a separate identity type.
3. **Business staff roles** — permissions an individual holds *within a specific business profile*,
   assigned by that business's owner (Section 20): **Business manager**, **Receivables staff**,
   **Accountant/Viewer**, plus business-defined **Custom role**. These are additive to, and
   constrained by, whatever agreement-scoped role the business itself holds on a given agreement.
4. **Non-party platform roles** — people who are not a party to the debt but interact with the
   agreement or the platform itself: **Witness**, **Platform administrator**, **Compliance
   reviewer**, **Support agent**.

A single login can hold multiple roles simultaneously across different scopes (e.g., a personal
user who is Borrower on Agreement A, Personal creditor on Agreement B, and also
Business manager on a separate verified business profile — Section 18).

## 2. Verification tier prerequisite (Section 17)

| Tier | Required for | Requirements |
|---|---|---|
| Basic | Signup, browsing, receiving an invitation | Verified email, verified phone, password/passkey, basic profile |
| Full (personal) | Signing an agreement, receiving money, activating payments | Legal name, DOB, residential address, government ID, selfie/liveness, bank-account ownership, payment-provider approval |
| Full (business) | Same triggers, for a business profile | Legal business name, entity type, EIN/SSN, business address, authorized representative, beneficial-owner info where required, verified business bank account, payment-provider business verification |

All roles below that can sign, receive funds, or approve financial terms require **Full**
verification at the relevant tier (personal or business) in addition to being 18+. Verification
failure blocks activation of the role's financial capabilities (Section 17) — it does not block
account creation itself.

## 3. Permissions matrix

Legend: ✅ = can do by default • ⚙️ = configurable (owner-defined, per Section 20) • 🚫 = cannot do
• N/A = not applicable to this role.

| Role | Create draft agreement | Acknowledge debt / sign as borrower | Accept & sign as creditor | Approve amendment / hardship / partial / settlement | View payment credentials (tokenized) | View gov't ID / bank credentials of other party | Upload / view evidence | Manage business staff & permissions | Export records | Access admin dashboard | Bound by MFA-gated actions (Sec. 26) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Personal user (base identity) | ✅ (as either party) | ✅ | ✅ | ✅ (for own agreements) | 🚫 (never — tokenized by processor) | 🚫 | ✅ (own agreements) | N/A | ✅ (own records) | 🚫 | ✅ |
| Borrower (agreement-scoped) | ✅ (may initiate draft) | ✅ (required) | N/A | ✅ (must approve any change) | 🚫 | 🚫 | ✅ | N/A | ✅ (own agreement) | 🚫 | ✅ |
| Personal creditor (agreement-scoped) | ✅ (may initiate draft) | N/A | ✅ (required) | ✅ (must approve any change) | 🚫 | 🚫 | ✅ | N/A | ✅ (own agreement) | 🚫 | ✅ |
| Business owner | ✅ | ✅ (if business is debtor) | ✅ (if business is creditor) | ✅ (ultimate authority; may delegate via caps) | 🚫 | 🚫 | ✅ | ✅ (full — invite/remove staff, set all permission ceilings) | ✅ | 🚫 | ✅ |
| Business manager | ⚙️ | ⚙️ (if authorized rep. on a debtor agreement) | ⚙️ | ⚙️ (up to owner-set caps: max settlement discount, max principal reduction, max date change, max partial-payment variance — Sec. 20) | 🚫 | 🚫 | ⚙️ | ⚙️ (only if owner grants; cannot exceed own ceiling) | ⚙️ | 🚫 | ✅ |
| Receivables staff | ⚙️ (typically limited to creating/managing agreements, not approving high-value changes) | 🚫 (not a party) | ⚙️ | ⚙️ (narrow — e.g., accept routine partial payments within small variance) | 🚫 | 🚫 | ⚙️ | 🚫 | ⚙️ | 🚫 | ✅ |
| Accountant / Viewer | 🚫 | 🚫 | 🚫 | 🚫 | 🚫 | 🚫 | ⚙️ (view only) | 🚫 | ⚙️ (view/export reports) | 🚫 | ✅ (for any action it can take) |
| Witness | 🚫 | 🚫 | 🚫 | 🚫 | 🚫 | 🚫 (never — Sec. 16 explicit prohibition) | ⚙️ (only explicitly shared documents, never banking/ID) | N/A | 🚫 | 🚫 | ✅ (attestation itself) |
| Platform administrator | 🚫 (cannot create/sign on behalf of a user — Sec. 29) | 🚫 | 🚫 | 🚫 (cannot alter a signed agreement or fabricate consent) | 🚫 (no raw credentials exist to view — processor-tokenized) | ⚙️ (verification status only, for compliance purposes, via traceable access) | ✅ (for review) | 🚫 (not a business-staff function) | ✅ (for authorized legal requests) | ✅ | ✅ (elevated) |
| Compliance reviewer | 🚫 | 🚫 | 🚫 | 🚫 (reviews/recommends; does not unilaterally alter agreements) | 🚫 | ⚙️ (review-only, logged) | ✅ (for review) | 🚫 | ⚙️ (for compliance case purposes) | ⚙️ (restricted subset — see gap below) | ✅ |
| Support agent | 🚫 | 🚫 | 🚫 | 🚫 | 🚫 | 🚫 | ⚙️ (limited, case-related) | 🚫 | 🚫 | ⚙️ (restricted subset — case/ticket view only) | ✅ |

## 4. Role detail

**Personal user.** Base identity for an individual. Holds one personal profile (Section 18). Can
hold multiple agreement-scoped roles across different agreements. Cannot sign, receive funds, or
activate payments until Full personal verification is complete (Section 17).

**Borrower.** Assigned per agreement to whichever party owes the money. Must formally acknowledge
the debt's existence, reason, amount, prior payments, and remaining balance before the agreement
can proceed to signatures (Section 3). Is the only party who can independently revoke ACH
authorization (Section 3, Section 6). Cannot receive funds under this agreement (that would require
a separate agreement where they are creditor).

**Personal creditor.** Assigned per agreement to whichever individual party is owed the money.
Reviews and accepts the borrower-acknowledged terms, then signs. Receives payouts through the
processor as installments clear (Section 7).

**Business owner.** The top-level authority over a single verified business profile (Section 18,
Section 20). Sets all staff roles and permission ceilings; is the default "authorized
representative" for B2B agreements unless delegated (Section 18A); required approver for
bank-account changes, beneficial-owner changes, owner changes, significant settlements,
staff-permission changes, and payout changes — all of which require elevated authentication
(Section 20, Section 26). A user's business profile(s) are separate from their personal profile,
each with its own bank accounts, agreements, pricing, records, and audit data (Section 18).

**Business manager.** A staff role the owner can configure to negotiate, approve, and sign on the
business's behalf up to owner-defined limits (Section 20): maximum settlement discount, maximum
principal reduction, maximum payment-date change, maximum partial-payment variance, and thresholds
above which two-person or owner approval is mandatory. May be designated as the **authorized
representative** for a B2B agreement (Section 18A), which must itself be verified as an actual
authority to create/negotiate/approve/sign/amend/settle/manage that agreement.

**Receivables staff.** A narrower staff role, typically limited to day-to-day agreement creation
and routine collections activity (e.g., initiating draft agreements, following up on past-due
installments, handling routine partial-payment requests within small owner-set variance) without
authority over settlements, forgiveness, or significant schedule changes. Exact default permission
set is business-configurable (Section 20); the spec does not prescribe fixed defaults beyond naming
the role, so a business's own configuration governs.

**Accountant / Viewer.** Read-oriented staff role: reports, records, and exports, without agreement
creation, signing, or approval authority (Section 20 lists "who can view reports" and "who can
export records" as separately configurable permissions, consistent with a viewer-class role).

**Custom role.** Owner-definable combination of the granular permissions enumerated in Section 20
(who can create agreements, send invitations, propose amendments, approve hardship requests, set
settlement/reduction/date/variance caps, require two-person or owner approval, export records,
change payment schedules, view reports). Not a fixed role — a configuration mechanism.

**Witness.** Optional, up to two per agreement (Section 16). May review the agreement and any
supporting documents explicitly shared with them, and confirm/attest that they witnessed
acknowledgment or signing. Explicitly barred from changing terms, approving amendments, accessing
payment credentials, accessing government ID, receiving funds, or controlling the agreement.
Attestations attach permanently to the specific version witnessed; an amended agreement cannot
silently inherit a prior witness's attestation (Section 16).

**Platform administrator.** Internal role operating the administrative dashboard (Section 29): can
suspend accounts, restrict payments/payouts, pause new-agreement creation, review
identity-verification status, fraud alerts, payment failures, disputes, and audit logs, and export
records for authorized legal requests. Explicitly cannot alter a signed agreement, fabricate
consent, rewrite payment history, delete an audit event, change a balance outside an authorized
traceable adjustment process, or sign on behalf of a user. Every administrative action must be
attributed, timestamped, reasoned, and reversible only through further traceable action (Section 29).

**Compliance reviewer.** Named in Section 36's role list but not independently defined in the
spec's body sections — the closest anchor is Section 30's appeals requirement that "the original
decision-maker" cannot be the sole appeal reviewer, and Section 29/31's references to fraud,
verification, and dispute review as administrative functions. Modeled here as a role distinct from
Platform administrator specifically to satisfy that separation-of-duties requirement: reviews
appeals, fraud flags, verification failures, and disputes, and can recommend or apply restrictions
within a defined authority band, but does not perform the broader account-suspension /
payout-restriction actions reserved for administrators unless explicitly granted. **This boundary
is an inference, not a spec-stated rule — flagged as an open decision.**

**Support agent.** Operates the Section 23/30 email-support and appeals intake function: can view
and work support cases and assign/track appeal case numbers, but per Section 29's restrictions
(shared by any non-owner platform role) cannot alter signed agreements, fabricate consent, or
adjust balances outside the authorized process. Its permission boundary relative to Compliance
reviewer (e.g., can a support agent escalate directly, or must all escalations route through
Compliance reviewer) is not specified in the spec — flagged as an open decision.

## 5. Cross-cutting rules that apply to every role above

- **MFA required for sensitive actions** regardless of role: signing, bank/debit-card/payout
  changes, settlement approval, debt forgiveness, staff-permission changes, business-ownership-data
  changes, sensitive-record export, account closure, credential reset (Section 26).
- **Every staff action must identify the employee and business profile** (Section 20); every
  administrative action must identify the administrator, role, timestamp, reason, before/after
  values, authorization level, and case reference (Section 29).
- **Removing staff access is immediate but non-destructive** — access is revoked without deleting
  the departing staff member's audit history (Section 20).
- **Business and personal activity must remain separated** even when the same login holds both a
  personal profile and one or more business profiles (Section 18).

---
*Next phase: Deliverable 3 — Complete user journeys.*
