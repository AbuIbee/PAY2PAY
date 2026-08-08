SPRINT 20 OBJECTIVE:
Prepare PAY2PAY for a controlled closed beta.

Do NOT perform unrestricted public financial launch.

Complete:

- end-to-end test suite
- staging environment
- Vercel preview/staging deployment verification
- Supabase staging configuration
- sandbox/test processor verification
- production configuration checklist
- observability
- structured logs
- error reporting
- uptime/health monitoring hooks
- reconciliation dashboard readiness
- support workflow
- beta-user flagging
- feature flags
- kill switches
- rollback plan
- database backup/restore test plan
- incident-response documentation
- beta telemetry
- seven-year retention behavior implemented and verified against the data model's retention
  schedule (`docs/DATA_MODEL.md` §7–8)
- deletion/minimization behavior tested: eligible records are actually removed/minimized on
  schedule when unheld
- retention holds tested end-to-end: a hold (retention/dispute/fraud-review/litigation, per Sprint
  18) provably blocks deletion of the records it covers, and deletion resumes correctly once every
  hold on a record is released
- backup/restore test plan explicitly includes at least one restore drill covering held records,
  confirming holds survive a restore

Create:

docs/BETA_READINESS_REPORT.md
docs/PRODUCTION_LAUNCH_CHECKLIST.md
docs/INCIDENT_RESPONSE.md
docs/ROLLBACK_PLAN.md

The production-launch checklist must require external approval for:

- fintech legal review
- processor underwriting approval
- required licensing conclusions
- privacy/terms
- ACH authorization
- card fee/surcharge model
- KYC/KYB provider
- OFAC/sanctions
- tax requirements
- security review
- Sharia review if public Sharia claims will be made
- production credentials
- domain configuration
- customer support readiness

Claude must not mark these external approvals complete without evidence.

At completion classify the project:

READY FOR CLOSED BETA
or
NOT READY FOR CLOSED BETA

Do not deploy unrestricted production financial functionality.

Stop.