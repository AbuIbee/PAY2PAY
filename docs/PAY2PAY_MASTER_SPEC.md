You are acting as a senior fintech product architect, payments engineer, security architect, UX strategist, database architect, and technical program manager.

Your assignment is to design a production-grade product specification and system architecture for a United States financial-technology platform that facilitates direct repayment agreements between people and businesses.

Do not begin writing application code yet.

Your first responsibility is to convert the requirements below into a complete, internally consistent Product Requirements Document, technical architecture, data model, security model, payment-state model, implementation roadmap, and risk register.

Do not invent business rules that conflict with the requirements. When a technical or legal decision is unresolved, identify it explicitly as an open decision rather than silently choosing an answer.

1. Product concept

The product is a mobile-responsive web application with Progressive Web App capabilities.

It must work effectively on:

- iPhone
- Android phones
- iPad
- Android tablets
- Windows laptops
- MacBooks
- Chromebooks
- Modern desktop and mobile browsers

The U.S. production launch will support U.S. users and U.S. dollars only.

The architecture should store country, currency, timezone, and locale fields so international support can be added later, but no international payments or international compliance workflows should be activated in the MVP.

The platform facilitates repayment agreements between:

- Friends and family
- Individuals
- Sole proprietors
- Small businesses
- Contractors
- Freelancers
- Mechanics and repair businesses
- Merchants offering installment repayment for goods or completed services

The platform must initially exclude:

- Professional debt collectors
- Debt buyers
- Payday lenders
- Interest-bearing lenders
- Businesses advancing loan proceeds
- Medical-debt collection
- Child-support collection
- Court-judgment enforcement
- Gambling debts
- Secured loans
- Any unlawful or prohibited transaction

The platform is not a lender.

The platform does not advance funds.

The platform does not guarantee repayment.

The platform does not intentionally hold customer funds.

Each successful payment should move through a qualified payment processor from the payer to the verified recipient.

Recipients receive money only as each installment successfully clears.

The platform supports personal-to-personal, business-to-consumer, consumer-to-business where appropriate, and business-to-business repayment agreements. In a B2B agreement, both parties act through separately identified business profiles, and each organization designates an authorized representative with permission to negotiate, approve, sign, amend, settle, and manage the agreement. Business identity verification is not a prerequisite to negotiate, approve, or sign — each business separately completes it before that business can receive money or activate payment capability (Section 17).

2. Ethical and Islamic-finance positioning

The platform should be marketed broadly as an ethical, interest-free repayment platform.

It is influenced by Islamic debt principles, but it must not publicly claim formal Sharia compliance until reviewed and approved by qualified Islamic-finance scholars or a Sharia supervisory body.

The platform must prohibit:

- Interest
- Riba
- Finance charges tied to repayment duration
- Percentage-based late fees
- Compounding charges
- Increasing the debt because more time has passed
- Prepayment penalties
- Fees disguised as interest

The platform may charge transparent fees for actual payment processing, platform access, agreement processing, or other legitimate services.

Fees cannot increase merely because repayment takes longer.

Businesses may pass through an actual, disclosed payment-processing or agreement-processing cost only when:

- The cost is identifiable
- It is separately disclosed
- It is not based on the debt percentage
- It does not increase with time
- The customer accepts it before signing
- The business does not mark it up for profit
- The platform enforces a reasonable cap

3. Agreement-creation principles

Either party may initiate a draft agreement.

The application acts as a neutral digital scribe.

The person who owes the money must formally acknowledge and confirm:

- That the debt exists
- The reason for the debt
- The amount owed
- Any previous payments
- The remaining balance
- The repayment terms
- The payment authorization

The recipient then reviews and accepts the agreement.

Both parties must electronically sign before activation.

After signing, the agreement becomes locked.

The original signed version must never be overwritten.

Every amendment must create a new version while preserving the original terms.

Any contractual change requires both parties’ approval.

This includes changes to:

- Total balance
- Installment amount
- Payment frequency
- Due dates
- Start date
- End date
- First-payment amount
- Final installment
- Fee allocation
- Hardship terms
- Settlement terms
- Payment pauses
- Partial-payment terms
- Cancellation
- Debt forgiveness

The borrower may independently revoke ACH authorization or disconnect a payment method where legally required.

Revoking payment authorization stops future automatic debits but does not erase the underlying debt agreement.

4. Required agreement information

Every agreement must require:

- Debt or transaction category
- Plain-language description
- Original amount
- Payments already made
- Remaining balance
- Supporting documentation when available
- Recipient identity
- Payer identity
- Payment method
- Mandatory first-payment amount
- Remaining installment schedule
- Payment frequency
- First scheduled payment
- Final scheduled payment
- Fee allocation
- Who pays processing fees
- Early-payment terms
- Hardship terms
- Partial-payment terms
- Settlement terms
- Dispute procedures
- Electronic-signature consent
- Payment authorization
- Optional witnesses

The agreement may include legitimate components of an original invoice, including:

- Product or service price
- Sales tax
- Shipping or delivery
- Installation
- Permit costs
- Filing costs
- Other legitimate original transaction charges

The agreement must not include charges added solely because the customer is paying over time.

5. Mandatory first payment

Every ordinary new agreement requires an immediate first payment.

The first-payment amount may be any amount mutually agreed upon.

It does not have to equal the normal recurring installment.

The app must calculate and display:

- Total acknowledged debt
- First payment
- Remaining principal
- Number of later installments
- Later installment amounts
- Payment frequency
- Final payment
- Uneven final payment caused by rounding

Agreement status should progress through states such as:

- Draft
- Awaiting payer acknowledgment
- Awaiting recipient acceptance
- Awaiting signatures
- Signed
- First payment pending
- Active
- Past due
- Disputed
- Paused by amendment
- Settled in full
- Paid in full
- Canceled by mutual agreement
- Closed

A signed agreement remains valid even if the first payment fails.

A failed first payment prevents the automated repayment schedule from becoming fully active but does not erase the signed debt acknowledgment.

6. Payment methods

The U.S. launch must support:

- ACH bank payments
- Debit cards

ACH should be presented as the standard low-cost payment method.

Debit cards should be available as an alternative.

The agreement specifies who pays the payment-processing fee.

If a borrower later switches from ACH to a more expensive debit-card method, the borrower pays the incremental processing cost unless both parties approve another allocation.

The creditor’s expected net proceeds must not be reduced without approval.

The system must separately track ACH and card payment states.

ACH payments may remain pending and later fail.

Debit-card payments may fail, expire, be replaced, or be disputed.

The application must not store raw bank-account credentials or complete debit-card credentials.

Sensitive payment information must be collected and tokenized by a qualified payments provider.

Evaluate an architecture using providers such as:

- Stripe Connect
- Stripe ACH Direct Debit
- Stripe Financial Connections
- Plaid Link
- Plaid Transfer
- Qualified alternatives

Do not assume provider approval.

Document the payment-provider underwriting risk and provide a contingency architecture if the preferred provider rejects the business model.

7. Payment routing and payouts

The platform should use a model in which the payment processor routes each successful payment to the verified recipient.

The platform should not intentionally receive customer money into its ordinary operating bank account.

Recipients receive only successfully cleared installments.

For the MVP:

- No funds are released before clearing or the processor’s required settlement period
- Standard processor payouts are the default
- No platform-funded advances
- No guaranteed payouts
- No instant access to unsettled ACH funds

Future releases may support:

- Faster payout for an additional fee
- Instant payout when the processor supports it
- Risk-based payout eligibility

Faster or instant payout should accelerate only cleared funds and should not turn the platform into the party assuming ACH return risk.

Payment states should include:

- Scheduled
- Submitted
- Processing
- Cleared
- Payout pending
- Paid out
- Failed
- Returned
- Reversed
- Disputed
- Refunded
- Canceled

Create a detailed state machine covering allowed and prohibited transitions.

8. Failed-payment workflow

When a payment fails:

- Notify both parties immediately
- Display a non-sensitive failure category
- Allow the borrower to make a manual payment
- Schedule one automatic retry after a configurable delay
- Default initial recommendation: three business days
- Cancel the retry if the borrower successfully pays manually
- If the retry fails, stop automatic attempts for that installment
- Allow the borrower to request a new date
- Require recipient approval before formal rescheduling
- Preserve the unpaid installment in the history

Do not implement automatic late fees.

Do not allow repeated uncontrolled retries.

9. Hardship workflow

A borrower may request:

- A new payment date
- Temporary pause
- Reduced installments
- Revised schedule

The request must include:

- Reason
- Requested relief
- Proposed effective date
- Proposed replacement terms

The creditor may:

- Accept
- Reject
- Counteroffer

The existing agreement remains controlling until both parties sign an amendment.

No interest, balance growth, or penalty may be added due to hardship.

10. Early payments

Borrowers may pay additional principal or pay the debt off early at any time without penalty.

A full cleared payoff automatically closes the agreement as Paid in Full.

For an extra payment that does not pay the balance completely, the borrower may propose:

- Keeping the installment amount and finishing sooner
- Reducing future installments while preserving the original final date

Any schedule change requires creditor approval.

11. Partial payments

Partial payments are allowed only after creditor approval.

The borrower submits:

- Proposed partial amount
- Proposed payment date
- Optional explanation
- Proposed treatment of the remaining unpaid portion

The creditor may accept, reject, or counteroffer.

The remaining balance stays due unless expressly forgiven.

Acceptance of a partial payment must not automatically constitute full settlement.

12. Settlements

The creditor and borrower may mutually agree to settle for less than the full balance.

The settlement must state:

- Pre-settlement balance
- Settlement amount
- Amount being forgiven
- Settlement deadline
- Whether payment is one-time or scheduled
- What happens if the settlement is not completed

The parties must explicitly choose the failed-settlement consequence, such as:

- Original unpaid balance is restored
- A specifically stated balance is restored
- A stated amount remains permanently forgiven
- The prior agreement remains controlling until a new arrangement is negotiated

After the settlement successfully clears, the status must be Settled in Full rather than Paid in Full.

13. Disputes

Either party may dispute the debt’s existence, amount, evidence, payment status, or agreement administration.

The disputing party must provide:

- Written explanation
- Dispute category
- Supporting evidence when available

The other party may respond and upload evidence.

The agreement is marked Disputed.

Scheduled payments continue unless:

- The borrower revokes authorization
- Both parties approve a pause
- The payment processor or administrator imposes a restriction

The platform must not decide the underlying legal dispute.

Any resolution changing the balance or schedule requires a signed amendment.

Users must be able to export a complete evidence package.

14. Unauthorized-payment disputes

When a borrower claims an ACH debit or debit-card charge was unauthorized:

- Mark the payment disputed
- Notify both parties
- Freeze recoverable unsettled funds when permitted
- Preserve the signed agreement
- Preserve the authorization mandate
- Preserve identity-verification results
- Preserve timestamps, IP address, device data, and consent events
- Submit appropriate evidence to the processor
- Allow the processor and banking system to resolve the payment dispute
- Do not independently declare either party legally correct

A reversed payment reduces the agreement’s paid balance unless both parties later agree otherwise.

The payment dispute and underlying debt dispute must remain separate concepts.

15. Evidence and documents

Before signing, either party may upload supporting evidence.

After signing, either party may continue uploading evidence.

All post-signing uploads must be labeled:

“Added after agreement signing.”

Post-signing evidence:

- Does not change the original contract
- Does not become part of the original signed version automatically
- Is timestamped
- Notifies the other party
- May be disputed
- Cannot be altered by the other party
- Cannot be presented as if it existed before signing

Evidence supporting the debt must be shared with both parties.

Examples include:

- Invoice
- Receipt
- Contract
- Estimate
- Purchase order
- Proof of delivery
- Proof of completed work
- Prior payment record

Sensitive information remains private, including:

- Government identification
- Bank credentials
- Complete bank-account numbers
- Complete debit-card data
- Identity-verification documents
- Unrelated internal business documents

Witnesses must never see banking or identity documents.

16. Witnesses

Witnesses are optional but encouraged.

An agreement may include up to two verified witnesses.

Witnesses may:

- Review the agreement
- Review explicitly shared supporting documents
- Confirm that they witnessed the acknowledgment or signing
- Electronically attest

Witnesses may not:

- Change terms
- Approve amendments
- Access payment credentials
- Access government identification
- Receive funds
- Control the agreement

Witness attestations remain attached permanently to the version witnessed.

Amended agreements may request new witness attestations, but prior signatures cannot be silently transferred to the amendment.

17. Identity verification

Use tiered identity verification.

Basic signup requires:

- Verified email
- Verified phone number
- Password or passkey
- Basic profile

Before receiving money or activating payments, require full verification:

- Legal name
- Date of birth
- Residential address
- Government-issued ID
- Selfie or liveness verification
- Bank-account ownership
- Payment-provider approval

Signing an agreement does not by itself require full verification. Signing has its own safeguards
(Section 26/27): authenticated session, required usable profile name, a fresh step-up/MFA
challenge, agreement-party authorization, and business signing authority for business signers.
Step-up/MFA verification performed at signing is not the same thing as full identity/KYC
verification, and completing one does not satisfy the other. Full verification remains required,
unchanged, before either party's first payment can be created, before receiving money, and before
activating payment capability.

All users must be 18 or older.

Underage users must be blocked.

For business profiles, require:

- Legal business name
- Entity type
- EIN or SSN for sole proprietor where appropriate
- Business address
- Authorized representative
- Beneficial-owner information where required
- Verified business bank account
- Payment-provider business verification

Verification failure must block activation.

18. Personal and business profiles

One login may contain:

- One personal profile
- Multiple separately verified business profiles

Each profile must have separate:

- Bank accounts
- Agreements
- Pricing
- Records
- Payment routing
- Reporting
- Staff access
- Audit data

A user may be a borrower on one agreement and a creditor on another.

Roles are defined per agreement.

Business and personal activity must remain separated.

Any agreement with proceeds deposited into a declared or verified business bank account must be treated as business activity.

The platform should not rely solely on automated bank-account classification because account-type detection may be incomplete.

Use:

- User declaration
- Identity or business verification
- Account ownership matching
- Internal risk review

Commercial transactions must be treated as business activity even when the business owner attempts to route proceeds through a personal profile.

18A. Business-to-business requirements

The platform must support business-to-business repayment agreements in which one verified business owes money to another verified business.

Examples include:

- Vendor invoices
- Contractor and subcontractor payments
- Wholesale purchases
- Equipment purchases
- Business service agreements
- Delivery and logistics charges
- Commercial repair work
- Professional services
- Purchase orders
- Past-due commercial invoices

For every B2B agreement:

- Both parties must act through separately identified business profiles.
- Each business must complete business identity verification before it can receive money or
  activate payment capability — not a prerequisite to negotiate, approve, or sign.
- Each business must designate an authorized representative.
- The application must verify that the representative has permission to create, negotiate, approve, sign, amend, settle, and manage the agreement.
- The agreement must record the legal name of each business.
- The agreement must record the signer’s name, title, role, and authority.
- Funds must be deposited into the creditor business’s verified business bank account.
- Business pricing applies to the creditor business.
- The pricing model must be configurable if both businesses are charged for premium business functionality.
- Supporting records may include invoices, purchase orders, contracts, estimates, statements of work, delivery confirmations, receipts, and proof of completed services.
- CSV imports may create draft B2B agreements.
- No imported B2B agreement becomes active until the debtor business reviews, acknowledges, and signs it.
- Staff permissions must control who can create, approve, amend, settle, export, and close B2B agreements.
- High-value B2B agreements may require two-person approval or owner approval based on configurable business rules.
- The app must maintain separate audit records for actions taken by each business and each authorized employee.
- The platform must prohibit interest, percentage-based late fees, compounding charges, and time-based finance charges in B2B agreements.
- Any amendment, hardship arrangement, partial payment, settlement, cancellation, or forgiveness requires authorized approval from both businesses.
- A change in the authorized representative must not alter or invalidate the existing signed agreement.
- B2B agreements must remain legally and operationally separate from personal agreements under the same user login.
- The platform must support business debtor and business creditor dashboards, including accounts payable, accounts receivable, upcoming payments, overdue installments, settlements, disputes, and exports.

19. Pricing logic

The app is free to download and access.

Personal users may have:

- A limited free plan
- A monthly subscription option
- A pay-per-agreement option
- Per-successful-payment fees

The free-plan limit should be based on:

- Number of agreements
- Number of included successful payments

Do not use total dollar amount as the primary free-tier threshold.

Use a hybrid model in which each agreement includes a defined number of successful installments before additional charges or an upgrade applies.

Exact allowances and prices are not yet final.

Do not hard-code speculative prices.

Create configurable pricing tables.

Business profiles pay:

- Standard annual fee
- Small transaction fee
- Payment-processing costs according to the signed fee allocation

Each separately verified business profile may require its own annual subscription.

Existing active agreements must not be terminated simply because a personal user exceeds a free-tier allowance.

Pricing changes should apply prospectively and should not rewrite signed fee terms.

20. Business staff and permissions

Business owners may invite staff members using separate logins.

Do not permit shared credentials.

Support role-based and granular permissions.

Potential roles:

- Owner/Admin
- Manager
- Receivables staff
- Accountant/Viewer
- Custom role

The owner may define:

- Who can create agreements
- Who can send invitations
- Who can propose amendments
- Who can approve hardship requests
- Maximum settlement discount
- Maximum principal reduction
- Maximum payment-date change
- Maximum partial-payment variance
- When two-person approval is required
- When owner approval is required
- Who can export records
- Who can change payment schedules
- Who can view reports

Bank-account changes, beneficial-owner changes, owner changes, significant settlements, staff-permission changes, and payout changes require elevated authentication and authorization.

Every staff action must identify the employee and business profile.

Removing staff access must be immediate without deleting their audit history.

21. Bulk imports and integrations

The early business release should support CSV uploads for:

- Customers
- Invoices
- Balances
- Proposed payment plans

CSV imports must include:

- Validation
- Preview
- Duplicate detection
- Error report
- Rejected-row reasons
- Draft creation only

A business may bulk-create drafts.

A business may not bulk-activate repayment agreements.

Each borrower must individually authenticate, review, acknowledge, and sign.

Future integrations may include:

- QuickBooks Online
- Xero
- FreshBooks
- Square
- Shopify
- Other justified industry systems

Do not build all integrations in the MVP.

Design an integration abstraction layer for future use.

22. Invitations

Agreements are shared through a secure link.

The link may be sent by:

- Email
- SMS
- WhatsApp
- Another messaging application

The secure link must:

- Expire
- Be revocable
- Be single-use after acceptance
- Reveal no sensitive debt details before authentication
- Require account creation or login
- Require full identity verification before the invited party can receive money or activate
  payments — not merely to sign (Section 17)
- Bind to the intended phone number or email when available
- Record creation, delivery, open, acceptance, expiration, and revocation events

A forwarded link must not permit an unintended person to accept the agreement.

23. Notifications

Support:

- Email
- SMS
- In-app notifications

Critical notifications cannot be disabled, including:

- Agreement signing
- Amendment
- Payment scheduled
- Payment processing
- Payment cleared
- Payment failed
- Payment disputed
- Bank-account change
- Debit-card change
- ACH authorization revocation
- Hardship request
- Partial-payment request
- Settlement request
- Security event
- Staff-permission change
- Payout-account change
- Account restriction

Users may control noncritical reminders.

The MVP will provide email customer support only.

Live chat and telephone support are future features.

24. Internal communication

The MVP must not include unrestricted internal chat.

Users may communicate outside the app.

Formal agreement actions must still occur inside the platform.

Later versions may add structured, agreement-specific messaging for:

- Hardship requests
- Amendments
- Disputes
- Settlement requests
- Document notices
- Payment issues

Do not design an unrestricted social chat system.

25. Credit reporting

Do not activate credit-bureau reporting in the MVP.

Architect the platform so positive-payment reporting can be added later.

Future reporting rules:

- Successful, on-time payments only
- No reporting of missed, failed, disputed, paused, or late payments
- Explicit borrower opt-in
- No adverse consequence for declining
- Optional paid business feature
- Businesses cannot report without recorded borrower consent
- Borrowers can view reported data
- Borrowers can dispute inaccuracies
- No guarantee that reporting improves a credit score

Document the future compliance requirements for becoming or using a data furnisher.

26. Multifactor authentication

Require multifactor authentication for sensitive actions, including:

- Signing an agreement
- Changing a bank account
- Changing a debit card
- Changing payout details
- Approving settlements
- Forgiving debt
- Changing staff permissions
- Changing business ownership data
- Exporting sensitive records
- Closing accounts
- Resetting security credentials

Prefer:

- Passkeys
- Authenticator applications
- Hardware-backed methods where available

SMS may be a fallback, not the preferred high-assurance method.

27. Electronic signatures

The MVP must create formal electronically signed agreements intended to be legally binding.

Capture and preserve:

- Electronic-signature consent
- Identity attribution
- Signer name
- Signer role
- Date and time
- Timezone
- IP address
- Device information
- Document version
- Agreement hash
- Consent events
- Authentication method
- Payment authorization
- Witness attestations
- Audit log

Both parties must receive a downloadable PDF copy.

The PDF must clearly show all financial terms, fees, signatures, version history, and payment authorization.

Use tamper-evident hashes and immutable version history.

Do not merely place a drawn signature image onto an editable document.

28. Data retention

Retain completed agreements, payment records, signatures, evidence, and audit logs for seven years after agreement closure.

Retention may be extended for:

- Active dispute
- Fraud investigation
- Litigation hold
- Subpoena
- Payment-provider requirement
- Legal or regulatory requirement

Account deletion must not erase records that must legally or operationally be retained.

Minimize or delete unrelated personal data when legally permitted.

Create a formal retention and deletion policy.

29. Administration

Create a secure internal administrative dashboard.

Authorized administrators may:

- Suspend accounts
- Restrict payments
- Pause new agreement creation
- Review identity-verification status
- Review fraud alerts
- Review payment failures
- Review disputes
- Review audit logs
- Restrict payouts where permitted
- Manage support cases
- Export records for authorized legal requests

Administrators must not be able to:

- Alter a signed agreement
- Fabricate consent
- Rewrite a payment history
- Delete an audit event
- Change a balance without an authorized, traceable adjustment process
- Sign on behalf of a user

Every administrative action must include:

- Administrator identity
- Role
- Timestamp
- Reason
- Before-and-after values
- Authorization level
- Case reference

30. Appeals

Users may appeal:

- Account suspension
- Fraud restriction
- Payout hold
- Administrative restriction

The MVP appeal method is email support.

The process must:

- Assign a case number
- Record the original restriction
- Accept supporting evidence
- Prevent the original decision-maker from being the sole appeal reviewer
- Preserve reviewer notes
- Record the decision and rationale
- Notify the user by email
- Keep restrictions in place during review unless an authorized reviewer lifts them

31. Fraud and risk management

Use both:

- Payment-processor fraud tools
- Internal risk rules

Flag patterns such as:

- Duplicate identities
- Shared bank accounts across unrelated users
- Shared devices across suspicious accounts
- Rapid creation of many agreements
- Repeated high-value agreements
- Frequent payment failures
- Chargebacks or ACH returns
- Frequent bank-account changes
- Abnormal settlement discounts
- Unusual payout changes
- Business activity routed through personal profiles
- Repeated invitations to unverifiable recipients
- Multiple accounts controlled by one actor
- Circular payment activity
- Self-payments
- Collusive agreements
- Account takeover indicators

Possible responses:

- Additional verification
- Manual review
- Temporary payment restriction
- Payout hold
- Agreement-creation restriction
- Account suspension

Risk rules must not erase agreements automatically.

Permanent restrictions require documented review.

32. Administrative and audit integrity

Create an append-only audit architecture.

Audit events should record:

- Actor
- Role
- Profile
- Agreement
- Action
- Timestamp
- IP address
- Device
- Previous value
- New value
- Reason
- Authentication strength
- Related document
- Related support or compliance case

Do not rely only on ordinary editable application logs.

Propose methods for tamper resistance, immutable storage, event hashing, and restricted access.

33. Technical expectations

Recommend a modern, secure stack suitable for a responsive PWA and future native mobile applications.

Evaluate a stack such as:

Frontend:

- Next.js
- React
- TypeScript
- Responsive accessible component system
- PWA support

Backend:

- TypeScript service architecture
- PostgreSQL
- Supabase or another managed PostgreSQL platform where appropriate
- Background jobs
- Webhooks
- Queueing
- Idempotency controls

Payments:

- Stripe Connect or equivalent
- ACH
- Debit card
- Bank-account linking
- Identity verification
- Connected recipient accounts

Documents:

- Secure object storage
- Virus scanning
- Encryption
- Signed URLs
- PDF agreement generation
- Document hashing

Notifications:

- Transactional email
- SMS
- In-app notifications

Security:

- Row-level authorization
- Role-based access control
- Attribute-based restrictions where needed
- Encryption in transit and at rest
- Secrets management
- Rate limiting
- Webhook signature validation
- Idempotent payment processing
- Secure session management
- Device and login monitoring
- Audit logging
- Backup and disaster recovery

Do not treat Supabase Row Level Security alone as the entire security strategy.

34. Accessibility and user experience

The application must be understandable to users who are not financially or technically sophisticated.

Design for:

- Plain-language explanations
- Mobile-first layouts
- Large touch targets
- Keyboard accessibility
- Screen-reader compatibility
- WCAG 2.2 AA targets
- High-contrast support
- Clear confirmation screens
- Clear status labels
- No dark patterns
- Transparent fee disclosure
- Explicit consent
- Preventing accidental signing
- Preventing accidental bank-account changes

The signing flow must include a final review screen summarizing:

- What is owed
- Why it is owed
- First payment
- Later payments
- Dates
- Fees
- Payment method
- Total borrower outflow
- Net recipient proceeds
- Cancellation rules
- ACH revocation rights
- Amendment rules
- Dispute process

35. MVP boundaries

The MVP should include:

- Responsive PWA
- Personal profiles
- Business profiles
- Tiered verification
- ACH payments
- Debit-card payments
- Payment agreements
- Mandatory first payment
- Electronic signatures
- Agreement PDF generation
- Amendments
- Hardship requests
- Partial-payment requests
- Settlements
- Disputes
- Supporting evidence
- Optional witnesses
- Email, SMS, and in-app notifications
- Business staff roles
- Configurable permissions
- CSV draft imports
- Administrative dashboard
- Fraud flags
- Email support
- Appeals
- Audit trail
- Seven-year retention model

The MVP should not include:

- International payments
- Multiple currencies
- Credit-bureau reporting
- Unrestricted internal chat
- Native iOS application
- Native Android application
- Instant access to unsettled funds
- Platform-funded lending
- Debt purchasing
- Professional collections
- Interest
- Late-fee profit
- Accounting integrations beyond architecture placeholders
- AI-based decisions that approve, reject, or legally adjudicate users

36. Required deliverables

Produce the following in this order:

Deliverable 1: Executive product summary

Explain:

- The product
- Target users
- Core value proposition
- What the platform is not
- MVP boundaries
- Primary legal and operational risks

Deliverable 2: User roles and permissions matrix

Include:

- Personal user
- Borrower
- Personal creditor
- Business owner
- Business manager
- Receivables staff
- Accountant/viewer
- Witness
- Platform administrator
- Compliance reviewer
- Support agent

Deliverable 3: Complete user journeys

Map step by step:

- Personal debt agreement
- Business invoice payment plan
- Borrower-initiated proposal
- Creditor-initiated proposal
- First payment
- Failed payment
- Retry
- Hardship request
- Partial payment
- Extra payment
- Full payoff
- Settlement
- Dispute
- Unauthorized-payment claim
- Witness attestation
- Business CSV import
- Staff approval
- Account restriction
- Appeal

Deliverable 4: Functional requirements

Use uniquely numbered requirements.

Include acceptance criteria for each requirement.

Deliverable 5: Nonfunctional requirements

Cover:

- Security
- Performance
- Reliability
- Availability
- Accessibility
- Auditability
- Scalability
- Privacy
- Retention
- Disaster recovery
- Observability

Deliverable 6: System architecture

Provide:

- Context diagram
- Component diagram
- Trust boundaries
- External services
- Data flows
- Webhook flows
- Background job flows
- Document flows
- Notification flows

Use Mermaid diagrams where appropriate.

Deliverable 7: Data model

Provide:

- Entity list
- Relationship description
- PostgreSQL schema proposal
- Primary keys
- Foreign keys
- Status enums
- Versioning strategy
- Audit strategy
- Soft-delete strategy
- Retention fields
- Indexes
- Uniqueness constraints
- Tenant and profile isolation model

Do not write production migrations yet.

Deliverable 8: State machines

Create explicit state machines for:

- Agreement lifecycle
- Payment lifecycle
- Amendment lifecycle
- Hardship request
- Partial-payment request
- Settlement
- Dispute
- Identity verification
- Business verification
- Appeal
- Payout
- Invitation

Identify invalid transitions.

Deliverable 9: Payment architecture

Explain:

- ACH flow
- Debit-card flow
- Connected recipient flow
- Fee allocation
- Payout flow
- Failed payment
- ACH return
- Chargeback
- Refund
- Reversal
- Idempotency
- Webhook handling
- Reconciliation
- Ledger design

Recommend double-entry ledger concepts even if the payment processor moves the actual money.

Deliverable 10: Security threat model

Use STRIDE or an equivalent methodology.

Cover:

- Account takeover
- Forged signatures
- Altered agreements
- Webhook spoofing
- Payment replay
- Duplicate withdrawals
- Invitation interception
- Document malware
- Staff abuse
- Administrator abuse
- Cross-tenant data leakage
- Business-profile confusion
- Fraudulent debt creation
- Collusion
- Synthetic identity
- Payout redirection

Deliverable 11: Compliance and legal-review checklist

Do not present legal conclusions as settled facts.

Identify issues requiring qualified U.S. fintech counsel, including:

- Money-transmission analysis
- Payment-processor agent structure
- ACH authorization
- Electronic signatures
- Consumer-credit implications
- Merchant installment arrangements
- Debt-collection law
- State licensing
- Privacy
- Data retention
- Credit reporting
- Fee disclosures
- Card surcharging
- Unfair or deceptive practices
- Tax reporting
- OFAC and sanctions
- KYC and business verification

Also identify items requiring qualified Sharia review.

Deliverable 12: Product roadmap

Separate:

- Prototype
- MVP foundation
- Payments sandbox
- Closed beta
- Legal and compliance validation
- Production pilot
- Public U.S. launch
- Post-launch features
- International expansion

Deliverable 13: Test strategy

Include:

- Unit tests
- Integration tests
- End-to-end tests
- Payment webhook tests
- Idempotency tests
- Authorization tests
- Row-level isolation tests
- Agreement immutability tests
- Signature tests
- Accessibility tests
- Security tests
- Fraud scenarios
- Disaster recovery tests
- Load tests

Deliverable 14: Open decisions

List all remaining decisions that must be resolved before coding or production.

Do not ask broad questions already answered in this specification.

Deliverable 15: Development work breakdown

Break the system into modules and implementation phases.

For each phase include:

- Goal
- Features
- Dependencies
- Risks
- Acceptance gate
- Security review gate
- Testing gate

37. Critical working rules

Do not generate the full production application in this response.

Do not generate thousands of lines of speculative code.

Do not invent legal compliance.

Do not claim the platform is licensed, compliant, certified, or Sharia-approved.

Do not recommend storing raw financial credentials.

Do not make the platform custodian of funds unless that decision is explicitly reviewed and approved.

Do not allow administrators to rewrite signed records.

Do not simplify asynchronous payments into immediate success states.

Do not treat payment-provider webhooks as automatically trustworthy without signature verification and idempotency.

Do not use floating-point types for money.

Use integer minor units or appropriate fixed-precision decimal handling.

Identify contradictions, gaps, unsafe assumptions, and areas where the requested product may be too broad for an MVP.

Be direct. If a requested feature creates unacceptable technical, operational, financial, legal, or security risk, state that clearly and propose a safer phased alternative.