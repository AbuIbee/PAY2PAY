SPRINT 18 OBJECTIVE:
Implement secure internal operational controls.

Roles may include:
- Support
- Compliance
- Fraud reviewer
- Admin

Administrators may:

- suspend account
- restrict payment activity
- restrict new agreements
- review verification status
- review fraud alert
- review dispute
- review audit logs
- restrict payout where processor permits
- manage support case
- manage appeal

Administrators may NOT:

- rewrite signed agreement
- fabricate signature
- delete payment history
- delete audit records
- impersonate consent
- arbitrarily change balances

Any authorized financial adjustment must use traceable compensating mechanism.

RETENTION AND LEGAL HOLDS

Sprint 18 owns operational retention controls:

- retention hold
- dispute hold
- fraud-review hold
- litigation/legal hold
- administrative retention override with audit trail
- deletion restrictions while hold exists

A hold of any type blocks scheduled deletion/minimization of the affected records until every
applicable hold on those records is explicitly released. Placing, extending, or releasing a hold
is itself an audited admin action (see "Every admin action audited" below) and must record: hold
type, record(s) affected, reason, placing admin, and release admin/timestamp when released.

Appeals:

- case ID
- evidence
- original decision
- reviewer
- rationale
- decision
- notification

Original decision-maker must not be sole appeal reviewer.

Every admin action audited.

Use strict authorization.

Tests for privilege escalation are mandatory.

Tests for retention holds are mandatory:
- hold blocks deletion
- multiple simultaneous holds all must clear before deletion
- hold placement/release is audited
- non-privileged user cannot place or release a hold

Cursor may later refine the admin UX.

Stop.