# PAY2PAY Production Launch Checklist

**Added:** SPRINT_20_ClosedBetaReadiness, one of the four documents this sprint's spec requires by
name. **This checklist gates unrestricted production launch — it is explicitly broader than, and
comes after, closed beta.** Closed-beta readiness is assessed separately in
`docs/BETA_READINESS_REPORT.md`; nothing on this page is a precondition for entering closed beta,
and closed beta entering successfully does not check off anything here automatically.

No item below may be marked complete without evidence (a document, a verified configuration, a
signed approval) — matching this sprint's own explicit instruction not to mark any external-approval
gate complete "based on assumption." Every row cites where the underlying detail already lives so
this document stays a checklist, not a duplicate of the analysis.

## A. External approvals (Product Owner / legal / compliance-held — this document cannot resolve these)

| Gate | Status | Evidence / reference |
|---|---|---|
| Fintech/money-transmission legal review | **NOT STARTED** | `docs/RISK_REGISTER.md` LEG-01 — no counsel review has occurred |
| Payment processor underwriting/contract | **NOT STARTED — no processor selected** | `docs/RISK_REGISTER.md` LEG-02; `docs/PRODUCTION_PROVIDER_READINESS.md` §1 |
| State-by-state money transmission / debt-adjusting / lending licensing | **NOT STARTED** | `docs/RISK_REGISTER.md` LEG-06 — national launch currently assumed, no state-specific logic exists |
| Privacy policy / terms of service legal sign-off | **DRAFTED, NOT LEGALLY REVIEWED** | `/privacy`, `/terms` pages exist and render (verified this sprint via Playwright, `e2e/pages.spec.ts`) but are product-authored copy, not counsel-reviewed |
| ACH authorization / NACHA compliance review | **NOT STARTED** | Depends on processor selection (LEG-02); `AchMandateService` implements the authorization-capture mechanism but its legal sufficiency is unreviewed |
| Card fee/surcharge model legal review | **NOT STARTED** | `docs/RISK_REGISTER.md` LEG-07 — surcharge-specific disclosure mechanism not yet designed |
| KYC/KYB provider selection and contract | **NOT STARTED** | `docs/PRODUCTION_PROVIDER_READINESS.md` §1, §5 — sandbox-only today |
| OFAC/sanctions screening coverage confirmed | **NOT STARTED** | `docs/RISK_REGISTER.md` LEG-09 — assumed delegated to a not-yet-selected provider |
| Tax information-reporting (e.g., 1099-K) requirements | **NOT STARTED — architecture gap** | `docs/RISK_REGISTER.md` LEG-08 — "not represented anywhere in current architecture" |
| Security review (independent, beyond this project's own Sprint 19 self-audit) | **NOT STARTED** | `docs/SECURITY_AUDIT_REPORT.md` is explicit that it is "not independent penetration-testing certification" |
| Sharia-compliance review (only if public claims are made) | **NOT STARTED — governance undecided** | `docs/RISK_REGISTER.md` PRD-06, LEG-03; `docs/COMPLIANCE_REVIEW_CHECKLIST.md` §S |

## B. Production credentials and infrastructure

| Gate | Status | Evidence / reference |
|---|---|---|
| Production financial provider credentials issued and configured | **BLOCKED — no provider selected** | `docs/PRODUCTION_PROVIDER_READINESS.md` §5 (per-provider go-live checklist, none started) |
| Production email delivery | **LIVE** | Resend configured, PRSprint 14, re-confirmed present in `docs/ENVIRONMENT_VARIABLES.md` |
| Production SMS delivery | **NOT LIVE — console-log only** | PRSprint 15 built the abstraction; Twilio account activation is an external, unstarted step |
| Domain configuration | **LIVE** — `https://paid2you.com` resolves and serves production traffic | Verified repeatedly across Phase 7 / Step 2 / Sprint 19 post-merge checks |
| Database backup / PITR | **DEFERRED (Product Owner decision)** — not required for closed beta, required before real money moves | `docs/OPERATIONS_BACKUP_RECOVERY.md` §1 |
| `master` branch protection | **RESOLVED** | `docs/OPERATIONS_CI_CD.md` §2, re-verified Step 2 (2026-08-22) |
| `CRON_SECRET` set and live in production | **SET, NOT YET ACTIVATED** — generated and stored in Vercel this sprint; scheduled jobs will pick it up on the next real merge to `master`, deliberately not forced via an out-of-band redeploy during this branch-only sprint | This sprint's own findings, §ENVIRONMENT_VARIABLES update |
| Rollback executor access confirmed for someone other than the Product Owner | **NOT CONFIRMED** | `docs/ROLLBACK_PLAN.md` §6 |

## C. Product/customer readiness

| Gate | Status | Evidence / reference |
|---|---|---|
| Customer support readiness (a real person/process behind `support@pay2pay.com` and the appeals flow) | **PRODUCT OWNER-HELD FACT — not verifiable from code** | `SupportAppeals.tsx` exists and is tested; whether a human process exists behind it is outside this codebase's scope |
| Pricing/fee tables finalized | **NOT FINALIZED** | `docs/RISK_REGISTER.md` PRD-03 — no default for B2B dual-pricing allocation |
| Transaction limit values approved as real business decisions (not placeholders) | **NOT APPROVED** | `docs/LAUNCH_RUNBOOK.md` §8 — Sprint 19's daily/per-payment caps use conservative placeholder defaults |
| Provider contacts documented | **NOT FILLED IN** | `docs/LAUNCH_RUNBOOK.md` §2 — template only |

## D. What this checklist does NOT gate

Closed-beta entry is governed separately by `docs/BETA_READINESS_REPORT.md` and does not require any
row above to be resolved — closed beta by design operates with sandbox financial providers, no real
money movement, and an invite-gated, small user population (`FEATURE_CLOSED_BETA_ENABLED`,
PRSprint 33). Conflating the two gates — treating closed-beta technical readiness as production
launch readiness — is the mistake this document exists to prevent.
