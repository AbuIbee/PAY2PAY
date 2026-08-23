# PAY2PAY Incident Response

**Added:** SPRINT_20_ClosedBetaReadiness, one of the four documents this sprint's spec requires by
name. This is the "what do I do right now" guide for closed beta. The severity definitions, the
per-scenario diagnostics, and the financial-safety reasoning it points to already exist in
`docs/OPERATIONS_BACKUP_RECOVERY.md` §3-4 and are not repeated here — this document sequences them
into a response process and adds what Sprint 20 found that those documents did not yet cover.

## 1. Severity levels

See `docs/OPERATIONS_BACKUP_RECOVERY.md` §3 for the full SEV-1..SEV-4 table with examples and
response expectations. Summary:

- **SEV-1**: real customer funds at risk, cross-tenant data exposure, auth bypass, raw banking
  credential exposure. Kill switch immediately, Product Owner notified immediately.
- **SEV-2**: payment processing degraded, single-tenant data exposed, a dependency outage.
- **SEV-3**: non-financial feature degraded, elevated but not total error rates.
- **SEV-4**: cosmetic, no customer impact.

## 2. First response, in order

1. **Check `GET /api/admin/health`** (PRSprint 28) — reports database reachability and dependency
   status. This is the fastest way to know whether you're looking at a database problem, a provider
   problem, or an application-layer bug.
2. **Check correlation IDs.** Every error response includes a `correlationId`
   (PRSprint 28) — use it to find the exact server-side log line for a specific user-reported error,
   rather than guessing from a generic client-facing message.
3. **Classify severity** (§1) and **contain** — for a SEV-1/SEV-2 involving payments or bank
   connections, flip the relevant kill switch (`docs/ROLLBACK_PLAN.md` §4) before doing anything
   else. Containment is not optional and does not wait for root cause.
4. **Notify the Product Owner** — immediately for SEV-1, within the incident window for SEV-2.
5. **Diagnose and fix** using `docs/OPERATIONS_BACKUP_RECOVERY.md` §3's per-scenario guidance
   (database outage, provider outage, suspected security incident, bad deployment, schema migration
   problem, cross-tenant access issue, compromised secret, webhook backlog).
6. **Recover** using `docs/ROLLBACK_PLAN.md` (application rollback, forward-fix migration, or — if
   truly unavoidable — the database-incident path, which currently has a disclosed, unresolved gap;
   see that document's §5).
7. **Re-enable** whatever kill switch was flipped once the root cause is fixed and verified.
8. **Write it down** — even a few sentences in a dated `docs/incidents/` entry (create the directory
   if this is the first one) of what happened, what was flipped, and what fixed it. No such log exists
   yet because no incident has occurred; start one the first time this document is actually used.

## 3. Fraud/risk signals (Sprint 19, new since the documents above were written)

A real signal ledger now exists: the `risk_event` table, `RiskEventService`, and an admin UI at
`/admin/risk-events` (gated by the `review_fraud_alert` capability). Two signal types are wired to a
live call site today (repeated payment failure, frequent bank-connection change); four more are
modeled in the schema but not yet connected. Treat a spike of `high`-severity, `open` risk events as
an early-warning signal worth checking during any payment-related incident, not just a standalone
admin task — `GET /api/admin/risk-events?openOnly=true` surfaces them.

## 4. Closed-beta-specific considerations

- **Data safety**: closed beta uses the same, single, production-linked Supabase database as
  everything else in this project — there is no separate "beta" database. An incident during closed
  beta is a production incident with the exact same severity/response process above; do not treat
  beta data as lower-stakes than any other production data.
- **Small user count**: with only invited/admin-approved beta users
  (`FEATURE_CLOSED_BETA_ENABLED`/`betaInviteService.ts`, PRSprint 33), a SEV-1/SEV-2 can plausibly be
  contained by directly contacting the small number of affected users, in addition to the kill-switch
  response above — this is a genuine advantage of the closed-beta phase worth using.
- **No status page**: the existing `/support` page is the only customer-facing incident-communication
  surface (`docs/OPERATIONS_BACKUP_RECOVERY.md` §6) — for closed beta's small user base this is
  judged sufficient; a real status page is deferred, not a blocker.

## 5. Known gaps carried into closed beta, not fixed by this document

- **Database backup/PITR**: DEFERRED by explicit Product Owner decision — see
  `docs/OPERATIONS_BACKUP_RECOVERY.md` §1 and `docs/ROLLBACK_PLAN.md` §5. If a genuine data-loss
  incident occurs during closed beta, there is currently no restore path beyond a manual, ad hoc
  export — this is a real, accepted risk of the current window, not an oversight.
- **Rollback executor identity**: who besides the Product Owner can execute a Vercel/Supabase
  rollback during an incident is not yet confirmed — see `docs/ROLLBACK_PLAN.md` §6.
- **Live provider incidents**: today's sandbox payment/KYC/card providers have no real external
  network dependency, so a "provider outage" is not a real production risk yet. This section must be
  revisited in full once a live provider is selected (`docs/PRODUCTION_PROVIDER_READINESS.md`).
