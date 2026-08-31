# Two-User Live Verification Checklist — Connection Account Privacy/Routing Remediation

Incident: cross-participant bank account disclosure and missing usage/role enforcement on connection
`P2P-EZ2R-V3MM`. Code-level fix is merged (see relevant commit / PR for file list). This checklist is
the acceptance gate before the incident can be closed — it must be executed against the actual
deployed environment (preview or production) by a human, using two real, distinct test accounts.

**This incident is not closed until every box below is checked against a live deployment, AND the
read-only production audit (`scripts/audit-relationship-financial-accounts.cjs`) has been run with no
unexplained findings.**

## Setup

- [ ] Environment under test identified and recorded here: `____________________` (preview URL or production)
- [ ] **User A ("Debtor")** — a real test account, with one verified bank account on file (e.g. "Bank A ending 1111")
- [ ] **User B ("Creditor")** — a separate real test account, with a *different* verified bank account on file (e.g. "Bank B ending 2222")
- [ ] A single connection/relationship created between User A (debtor) and User B (creditor), both accepted
- [ ] If checking the original incident connection specifically: `P2P-EZ2R-V3MM` — its actual debtor/creditor accounts (per the audit script's section 1 output)

## Part 1 — Debtor view (logged in as User A)

Open the Connection Detail page for the shared connection.

**Must see:**
- [ ] A card titled **"Your payment account"** with the row title **"Pay from (funding)"**
- [ ] User A's own bank institution name and last four digits displayed in that row
- [ ] An account selector populated **only** with User A's own verified accounts, plus an Assign/Replace control
- [ ] A separate card titled **"Counterparty"** showing exactly **"Receiving account: Ready"** or **"Receiving account: Not ready"** — nothing else

**Must NOT see anywhere on the page:**
- [ ] User B's bank institution name
- [ ] User B's account last four digits
- [ ] Any dropdown/selector offering User B's accounts
- [ ] Any editable "Receive to (payout)" control
- [ ] Any financial-account id, provider name, or Plaid/provider reference belonging to User B

## Part 2 — Creditor view (logged in as User B)

Open the same Connection Detail page.

**Must see:**
- [ ] A card titled **"Your payment account"** with the row title **"Receive to (payout)"**
- [ ] User B's own bank institution name and last four digits displayed in that row
- [ ] An account selector populated **only** with User B's own verified accounts, plus an Assign/Replace control
- [ ] A separate card titled **"Counterparty"** showing exactly **"Funding account: Ready"** or **"Funding account: Not ready"** — nothing else

**Must NOT see anywhere on the page:**
- [ ] User A's bank institution name
- [ ] User A's account last four digits
- [ ] Any dropdown/selector offering User A's accounts
- [ ] Any editable "Pay from (funding)" control
- [ ] Any financial-account id, provider name, or Plaid/provider reference belonging to User A

## Part 3 — Tampering test (server-side authorization, not just UI hiding)

Use browser devtools / an API client (curl, Postman) authenticated as each user in turn. All requests
target `POST /api/relationships/accounts/assign` and `POST /api/relationships/accounts/replace`.

- [ ] As **User A**, submit `{ usage: "payout", financialAccountId: <User A's own account id> }` → expect **403**
- [ ] As **User A**, submit `{ usage: "funding", financialAccountId: <User B's account id> }` → expect **403**
- [ ] As **User B**, submit `{ usage: "funding", financialAccountId: <User B's own account id> }` → expect **403**
- [ ] As **User B**, submit `{ usage: "payout", financialAccountId: <User A's account id> }` → expect **403**
- [ ] As **User A**, submit the legitimate `{ usage: "funding", financialAccountId: <User A's own account id> }` → expect **200/201** (proves the fix isn't over-broad)
- [ ] As **User B**, submit the legitimate `{ usage: "payout", financialAccountId: <User B's own account id> }` → expect **200/201**

## Part 4 — Payment routing test

- [ ] With both accounts assigned as above, trigger the debtor's mandate authorization
      (`POST /api/agreements/payment-setup/authorize-mandate`) as User A on a linked agreement
- [ ] Confirm (via `achMandateService.getActiveMandate` / admin view / logs) that the mandate's
      `bankAccountRef` resolves to **User A's** account, never User B's
- [ ] Confirm no `payment_routing_funding_owner_mismatch` error was logged for this agreement

## Part 5 — Regression spot-check

Confirm none of the following broke:

- [ ] Connection invitation (create + send)
- [ ] Connection acceptance
- [ ] New Agreement creation
- [ ] "Next: Terms" flow
- [ ] Agreement acceptance
- [ ] Agreement activation
- [ ] "Make a payment"
- [ ] Account replacement (own slot, with step-up challenge)
- [ ] Mutual cancellation workflow

## Part 6 — Read-only production data audit

- [ ] Run `node scripts/audit-relationship-financial-accounts.cjs` against the target environment
      (see the script's own header for exact guarantees: SELECT-only, no writes, no schema changes,
      no automatic remediation, prints the host/database/environment and requires typed confirmation
      before querying)
- [ ] Paste the script's "JSON SUMMARY" block output into the incident thread
- [ ] If any count is non-zero, **do not modify data** — report the findings for analysis before any
      remediation plan is proposed

## Sign-off

- [ ] All of Parts 1–6 above pass with no unexplained findings
- [ ] Findings (if any) have been reviewed and a remediation plan (if needed) has been explicitly approved
- [ ] Incident `P2P-EZ2R-V3MM` may be marked closed
