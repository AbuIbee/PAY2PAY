SPRINT 4 OBJECTIVE:
Implement business staff membership, RBAC, granular permissions, and approval limits.

Required roles:

- Owner/Admin
- Manager
- Receivables
- Accountant/Viewer
- Custom

Do not use role names alone as authorization.

Implement explicit permission capabilities.

Capabilities include:

- create_agreement
- send_invitation
- approve_agreement
- propose_amendment
- approve_hardship
- approve_partial_payment
- approve_settlement
- forgive_principal
- export_records
- view_reports
- manage_staff
- change_payout_configuration
- approve_high_value_action

Implement:

- staff invitation
- invitation expiration
- staff acceptance
- removal
- immediate session/access revocation where necessary
- custom roles
- settlement approval limits
- balance-adjustment limits
- two-person approval configuration
- owner-required thresholds

High-risk changes require elevated authentication hooks: call Sprint 2's `requireStepUp(user,
action)` before permission changes, custom-role edits, threshold changes, and staff removal
affecting high-risk capabilities. Do not implement a second, competing authentication mechanism.

Do not implement payments yet.

Audit every staff action.

RLS must isolate each business.

Required tests:

- owner permissions
- manager permissions
- viewer denial
- custom permission
- privilege escalation attempt
- staff self-promotion attempt
- removed staff
- cross-business access
- threshold enforcement
- dual approval

Update docs.

Stop after Sprint 4.