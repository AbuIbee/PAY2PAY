# Sprint 6A — Platform Administration & Audit Control

## Status

PLANNED — DO NOT BEGIN UNTIL SPRINT 6 IS COMPLETE

## Dependency

Sprint 6 must be:

* Development complete
* Git committed
* Pull request complete
* CI passing
* Merged
* Vercel preview/deployment verified
* ChatGPT/Product Owner reviewed

Sprint 6A must not interrupt active Sprint 6 development.

---

# Objective

Implement the secured administrative control plane for the Paid2Play platform.

The system must provide authorized administrators with user administration, support, troubleshooting, system visibility, test-account management, auditing, and operational oversight without creating an undocumented security bypass or allowing administrators to silently manipulate contractual or financial records.

The administrative architecture must support three initial authorization roles:

1. Platform Owner
2. Platform Admin
3. Member

Business and Individual remain account types, not security roles.

---

# Authorization Model

## 1. Platform Owner

Highest level of platform authority.

Initially this role will be assigned only to the platform owner.

### Platform Owner capabilities

Platform Owner may:

* Access all administrative interfaces.
* Search and view all users.
* View user profiles and account metadata.
* Suspend or reactivate user accounts.
* View all agreements for support and administrative purposes.
* View all transaction/payment records.
* View system and application errors.
* View audit events.
* View authentication/security events.
* Manage test accounts.
* Access read-only support impersonation/view-as-user functionality.
* Add administrative/support notes.
* Manage Platform Admin accounts.
* Promote eligible users to Platform Admin.
* Revoke Platform Admin privileges.
* Manage high-level application configuration.
* Manage administrative configuration.
* Manage feature flags where implemented.
* Manage authorization/security configuration where application tooling permits.
* Perform documented emergency ownership recovery procedures.
* Access platform-owner-only administrative screens.

### Platform Owner restrictions

Platform Owner must NOT:

* Delete audit history through the application.
* Disable audit logging.
* Modify completed financial records without generating an auditable corrective event.
* Silently modify contractual agreement history.
* Perform user actions while masquerading as that user.
* Circumvent agreement acceptance requirements.
* Circumvent required authorization by modifying browser state.

Owner privileges must be verified server-side.

---

# 2. Platform Admin

Operational administrator one level below Platform Owner.

This role exists for future employees, support personnel, operations personnel, or trusted administrators who need broad administration capabilities without ownership of the platform.

### Platform Admin capabilities

Platform Admin may:

* Access the Admin Console.
* Search all users.
* View user account information.
* View account status.
* View agreements.
* View transaction/payment status.
* View application/system errors.
* View audit logs.
* View authentication activity appropriate for support.
* Suspend ordinary Member accounts.
* Reactivate ordinary Member accounts.
* Troubleshoot Member accounts.
* Manage test accounts.
* Create support notes.
* Use read-only support view.
* Investigate failed processes.
* Investigate failed payments/webhooks where implemented.
* View operational application configuration necessary for troubleshooting.
* Perform normal daily administrative support functions.

### Platform Admin must NOT:

* Create another Platform Admin.
* Promote a Member to Platform Admin.
* Promote any account to Platform Owner.
* Demote or suspend a Platform Owner.
* Modify a Platform Owner account.
* Modify another administrator's privilege level.
* Change the application's RBAC model.
* Change RLS security policies through the application.
* Change security-critical system settings.
* Change platform ownership.
* Access service-role secrets.
* Access database credentials.
* Disable audit logging.
* Delete audit history.
* Modify audit records.
* Perform break-glass recovery.
* Silently modify contractual records.
* Silently modify payment history.

Attempts to perform prohibited actions must be rejected server-side and, where appropriate, recorded as security/audit events.

---

# 3. Member

Default role for all customers.

This applies to both:

* Individual accounts
* Business accounts

Business versus Individual is an account classification and must remain separate from authorization role.

### Member capabilities

Members may interact with records and functionality to which normal application rules grant them access.

Examples include:

* Manage own profile.
* Create agreements.
* Participate in agreements.
* Accept or reject permitted agreement actions.
* Request agreement modifications.
* View agreements involving the Member.
* View permitted payment/transaction history.
* Manage personal account settings.
* Upload permitted files.
* Receive platform notifications.
* Perform ordinary application functionality.

### Member restrictions

Members must NOT:

* Access administrative routes.
* Access administrative APIs.
* Search the global user directory.
* Access unrelated customer records.
* View global audit logs.
* View system logs.
* View administrative notes.
* Suspend users.
* Change roles.
* Change authorization settings.
* Access test-account management.
* Access application operational configuration.

---

# Database Authorization Model

Create or extend the user/profile data model to support explicit authorization.

Recommended conceptual structure:

profiles

* id
* email
* account_type
* platform_role
* account_status
* is_test_account
* created_at
* updated_at

## platform_role

Supported values for Sprint 6A:

* member
* platform_admin
* platform_owner

Default:

member

No client application may determine its own trusted role.

Role information must originate from trusted server/database-controlled data.

Do not trust:

* localStorage
* sessionStorage
* query parameters
* URL routes
* client React state
* browser cookies containing unsigned role data
* hidden frontend controls

for authorization.

---

# Account Type

Maintain account type independently from security role.

Example:

account_type:

* individual
* business

platform_role:

* member
* platform_admin
* platform_owner

A business customer normally remains:

account_type = business

platform_role = member

Do not create unnecessary Business Admin or Individual Admin authorization roles in Sprint 6A.

---

# Account Status

Support at minimum:

* active
* suspended

Architecture may allow future states such as:

* pending
* disabled
* closed

but do not introduce unnecessary workflow complexity during Sprint 6A.

Suspension enforcement must occur server-side.

A suspended user must not regain application access merely by manipulating frontend state.

---

# Test Accounts

Test accounts must become a first-class platform concept.

Add:

is_test_account BOOLEAN NOT NULL DEFAULT FALSE

Authorized administrators must be able to identify test accounts clearly.

Initial test personas should include at minimum:

* Test Individual / Party A
* Test Individual / Party B
* Test Business
* Test Platform Admin

Platform Owner account is not considered an ordinary test account.

Test account activity should be identifiable so production reporting and analytics can exclude test records where required.

Do not hard-code test credentials into the repository.

Do not commit test passwords, API credentials, service-role keys, or secrets.

---

# Admin Console

Implement a protected administrative area.

Recommended route:

/admin

All /admin routes must require server-verified authorization.

Hiding navigation is NOT sufficient protection.

A Member manually typing an admin URL must still be denied.

---

# Admin Dashboard

Provide an administrative dashboard containing useful operational information.

Initial dashboard should support visibility into:

* Total users
* Active users
* Suspended users
* Test users
* Individual accounts
* Business accounts
* Agreement counts
* Relevant transaction/payment status
* Recent administrative activity
* Recent system errors where available
* Recent failed operations where available

Do not add vanity metrics simply to fill the dashboard.

---

# User Administration

Implement an Admin Users area.

Administrators must be able to:

* Search users.
* Filter users.
* Open user details.
* View account type.
* View platform role.
* View account status.
* View test-account indicator.
* View account creation date.
* View relevant activity information.
* View agreements associated with the account.
* View relevant transactions associated with the account.
* View administrative notes.
* Suspend eligible Member accounts.
* Reactivate eligible Member accounts.

Platform Admin must not suspend or alter Platform Owner.

Platform Admin must not modify administrative roles.

---

# Role Administration

Role management is Platform Owner only.

Platform Owner must be able to:

* Promote eligible Member → Platform Admin.
* Demote Platform Admin → Member.

Platform Admin must not be able to change roles.

Role changes must:

* Require server-side authorization.
* Produce an audit event.
* Record actor.
* Record target user.
* Record previous role.
* Record new role.
* Record timestamp.

Architecture should support future expansion of administrative roles without requiring wholesale redesign.

Do NOT implement additional administrative roles during Sprint 6A.

---

# Agreements Administration

Authorized administrators should be able to find and inspect agreements for support and troubleshooting.

Admin access does not imply authority to silently rewrite agreement history.

Administrators may:

* Search agreements.
* View agreement status.
* View parties.
* View agreement history.
* View audit history.
* View relevant transaction history.
* Investigate support issues.

Any future corrective action that changes contractual data must produce immutable evidence containing at minimum:

* Administrative actor
* Timestamp
* Previous value
* New value
* Reason
* Related entity
* Request/correlation identifier where available

Completed contractual history must never simply disappear.

---

# Transaction / Payment Administration

Where payment functionality exists, administrators should be able to inspect:

* Transaction identifier
* Associated agreement
* Parties
* Status
* Creation timestamp
* Completion timestamp
* Failure status
* Error information appropriate for administrators

Do not expose sensitive payment credentials.

Never expose full secrets, private keys, provider credentials, or prohibited financial data in the Admin Console.

---

# Support View

Implement a read-only support-view architecture.

Purpose:

Allow authorized administrators to understand what a Member sees without becoming that Member for contractual purposes.

Support view must:

* Clearly display an ADMIN SUPPORT VIEW banner.
* Be read-only.
* Disable contractual acceptance actions.
* Disable payment initiation.
* Disable agreement creation.
* Disable agreement modification.
* Disable identity-sensitive actions.
* Generate an audit event when initiated.
* Record which administrator viewed which account.
* Record start time.
* Record end time where practical.

Do NOT implement unrestricted "Log in as user" impersonation during Sprint 6A.

---

# Administrative Notes

Support administrators should be able to record internal troubleshooting notes.

Administrative notes must:

* Identify author.
* Identify target user/entity.
* Include timestamp.
* Be unavailable to ordinary Members unless explicitly designed otherwise.
* Be auditable.
* Not overwrite historical notes.

---

# Audit Logging

Implement a centralized audit-event framework.

Audit records must be treated as append-only application records.

Conceptual table:

audit_events

* id
* created_at
* actor_user_id
* actor_role
* action
* entity_type
* entity_id
* target_user_id
* old_value
* new_value
* reason
* metadata
* ip_address where safely/appropriately available
* user_agent where safely/appropriately available
* request_id / correlation_id

Exact schema may vary based on existing architecture.

Avoid storing secrets inside audit metadata.

---

# Minimum Audit Events

Support at minimum:

USER_CREATED

USER_SUSPENDED

USER_REACTIVATED

ROLE_CHANGED

TEST_ACCOUNT_CREATED

TEST_ACCOUNT_CHANGED

ADMIN_USER_VIEWED

ADMIN_SUPPORT_VIEW_STARTED

ADMIN_SUPPORT_VIEW_ENDED

ADMIN_NOTE_CREATED

LOGIN_SUCCESS where architecture supports it

LOGIN_FAILED where architecture supports it

AGREEMENT_CREATED

AGREEMENT_ACCEPTED

AGREEMENT_REJECTED

AGREEMENT_CHANGE_REQUESTED

AGREEMENT_COMPLETED

PAYMENT_INITIATED where applicable

PAYMENT_COMPLETED where applicable

PAYMENT_FAILED where applicable

ADMIN_CORRECTIVE_ACTION where applicable

SECURITY_ACCESS_DENIED

Do not fabricate events for application functionality that does not yet exist.

---

# Audit Integrity

Application users must not be able to:

* Update audit records.
* Delete audit records.

Platform Admin must not be able to:

* Update audit records.
* Delete audit records.

Platform Owner must not have an ordinary application UI control that deletes audit records.

Appropriate backend/database maintenance procedures may exist separately, but they must not be implemented as casual Admin Console functionality.

---

# Administrative Action Reasons

High-impact administrative actions should require a reason.

Examples:

* Suspending account.
* Reactivating account.
* Administrative corrective action.
* Changing Platform Admin role.
* Changing test-account designation when operationally significant.

Reason must be captured in the audit record.

---

# Security Enforcement

Authorization must use defense in depth.

At minimum verify security at:

1. Application route layer
2. Server/API layer
3. Supabase/PostgreSQL authorization/RLS layer where applicable

Frontend visibility is presentation logic, not security.

---

# Supabase / RLS Requirements

Review all relevant Row Level Security policies.

Ensure:

* Members cannot globally enumerate users.
* Members cannot retrieve unrelated user profiles.
* Members cannot retrieve unrelated agreements.
* Members cannot retrieve unrelated transactions.
* Members cannot access administrative notes.
* Members cannot access global audit records.
* Members cannot change their platform_role.
* Members cannot change their own account_status to bypass suspension.
* Members cannot mark themselves as test accounts where restricted.
* Platform Admin receives only necessary administrative access.
* Platform Owner receives intended platform authority.
* Service-role credentials are never exposed client-side.

Do not solve authorization by disabling RLS globally.

---

# Client Tampering Tests

The following must fail for Member accounts:

1. Manually navigate to /admin.
2. Call protected admin API directly.
3. Modify localStorage role.
4. Modify browser/session state.
5. Modify client-side React state.
6. Attempt another user's ID in API requests.
7. Attempt direct Supabase access to unrelated records.
8. Attempt to change own platform_role.
9. Attempt to change own account_status.
10. Attempt to read audit events.

Expected result:

Access denied server-side/database-side.

---

# Platform Admin Boundary Tests

The following must fail for Platform Admin:

1. Promote Member to Platform Admin.
2. Promote account to Platform Owner.
3. Demote Platform Owner.
4. Suspend Platform Owner.
5. Modify Platform Owner privilege.
6. Delete audit records.
7. Modify audit records.
8. Disable auditing.
9. Change core RBAC security settings.
10. Execute Platform Owner-only recovery functions.

Expected result:

403 / authorization denied and appropriate security/audit logging.

---

# Platform Owner Tests

Platform Owner must successfully:

* Access admin dashboard.
* Search Members.
* View user details.
* Suspend eligible Member.
* Reactivate Member.
* View agreements.
* View relevant transactions.
* View audit history.
* Manage test accounts.
* Create Platform Admin.
* Demote Platform Admin.
* Access owner-only settings.

Each relevant administrative action must generate appropriate audit evidence.

---

# Break-Glass Recovery

Document emergency ownership recovery.

Do NOT create:

* Hidden URLs
* Master passwords
* Hard-coded admin credentials
* Secret query parameters
* Universal bypass accounts
* Undocumented database bypasses

Emergency recovery should depend on legitimate infrastructure ownership and controlled restoration of authorization.

Document:

* How ownership is verified.
* How platform owner access is restored.
* Which infrastructure account is required.
* How the incident is recorded.
* What credentials must be rotated following compromise where appropriate.

The break-glass mechanism must remain outside normal Member-facing application functionality.

---

# Administrative Security

Platform Owner and Platform Admin accounts should be prepared for stronger authentication controls.

If MFA is already supported by the authentication architecture, require or prepare enforcement for administrator accounts.

Do not weaken normal authentication to make administrative development easier.

Administrative sessions should follow appropriately conservative session/security practices.

---

# UI Requirements

Admin Console should visually distinguish administrative functionality from customer application functionality.

At minimum provide navigation for:

Dashboard

Users

Agreements

Transactions

Test Accounts

Audit

System / Errors

Settings

Settings may contain Owner-only sections.

Hide Owner-only controls from Platform Admin UI, but remember that server-side authorization remains mandatory even when controls are hidden.

---

# Admin User Detail View

Recommended user administration layout:

USER OVERVIEW

Identity

Account Type

Role

Status

Test Account

Created

Last Relevant Activity

AGREEMENTS

TRANSACTIONS

SUPPORT NOTES

AUDIT HISTORY

ADMINISTRATIVE ACTIONS

For Platform Admin:

Only permitted actions appear.

For Platform Owner:

Owner-authorized administrative controls may appear.

---

# Error / Operational Visibility

Where supported by the current application architecture, provide administrators useful visibility into:

* Failed application operations.
* Failed API requests.
* Failed webhooks.
* Authentication failures.
* Processing failures.
* Relevant server/application errors.

Do not expose secrets, tokens, passwords, private keys, or sensitive raw credentials in logs.

If the current platform uses an external logging/error service, integrate appropriately rather than duplicating unnecessary infrastructure.

---

# Non-Goals for Sprint 6A

Do NOT implement:

* Five or six tiers of administrator.
* Department-level permission hierarchies.
* Granular SharePoint-style custom permission levels.
* Unrestricted user impersonation.
* Hidden admin backdoors.
* Master passwords.
* Admin ability to silently alter agreements.
* Admin ability to silently alter payment history.
* Audit deletion UI.
* Complex enterprise IAM unless already required.
* Custom administrator permissions editor.
* Organization-level delegated administration unless required by existing product scope.

Keep Sprint 6A focused.

---

# Required Roles After Sprint 6A

Exactly:

platform_owner

platform_admin

member

Additional administrative roles may be introduced in a future sprint if operational requirements justify them.

---

# Acceptance Criteria

Sprint 6A is complete only when:

* Platform Owner role exists.
* Platform Admin role exists.
* Member role exists.
* Existing users safely default to Member where appropriate.
* Role authorization is server-enforced.
* Relevant RLS policies are updated.
* /admin is protected.
* Admin Dashboard works.
* User search works.
* User detail view works.
* Account suspension works.
* Account reactivation works.
* Platform Admin restrictions work.
* Platform Owner role-management capabilities work.
* Test accounts are supported.
* Audit-event storage exists.
* Required admin actions are audited.
* Members cannot read audit logs.
* Administrators cannot delete audit logs through the application.
* Read-only support view works or its complete secured infrastructure is implemented according to existing sprint scope.
* No unrestricted impersonation exists.
* Break-glass recovery is documented.
* Security tests prove Member authorization bypass attempts fail.
* Security tests prove Platform Admin cannot exercise Platform Owner authority.
* Tests pass.
* Build passes.
* CI passes.
* No regression of Sprint 1–6 functionality.
* Vercel preview is functional.
* Database migrations are documented and reproducible.
* No credentials or secrets are committed.

---

# Regression Requirement

Sprint 6A must not break existing completed Sprint 1–6 functionality.

Run the existing automated test suite plus the new administrative authorization tests.

Any regression discovered during Sprint 6A must be documented and corrected before Sprint 6A can be declared complete.

---

# Git / Sprint Control

Follow CLAUDE.md.

Follow docs/SPRINT_CONTROL.md.

Sprint 6A must have its own branch/PR history consistent with the current project workflow.

Do not begin Sprint 7.

At Sprint 6A completion:

1. Ensure tests pass.
2. Ensure CI passes.
3. Provide database migration summary.
4. Provide security/RLS summary.
5. Provide changed-files summary.
6. Provide test results.
7. Provide Vercel preview status.
8. Identify any remaining risks.
9. Stop.

Final response must state:

Awaiting ChatGPT/Product Owner Sprint 6A review. I will not begin the next sprint.
