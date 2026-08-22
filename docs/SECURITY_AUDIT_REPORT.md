# PAY2PAY Security Audit Report — Sprint 19

**Path:** `docs/SECURITY_AUDIT_REPORT.md` (required deliverable named by `docs/sprints/SPRINT_19_FraudRisk_SecurityHardening.md`)
**Date:** 2026-08-22
**Scope:** Internal fraud/risk controls and application security hardening, per the Sprint 19 spec and the detailed SPRINT_19_FraudRisk_SecurityHardening execution instructions.

## Disclaimer

**This is not independent penetration-testing certification.** It is a code-level security review and adversarial-test pass performed by Claude against this codebase's actual implementation, backed by automated tests that are part of this repository and re-runnable by anyone. No external penetration tester, red team, or independent security firm was engaged. Provider-dependent findings (Twilio, live financial providers) are explicitly unverifiable until those providers are activated in production — see §4.

## 1. Method

Six parallel investigation passes (account-takeover/auth, registration/invitations, agreement/payment/ledger/concurrency, bank-connections/webhooks/providers, RLS/admin/audit/fraud-signals, API/web-hardening/secrets/dependencies) audited the actual implementation — not design docs, not prior sprint claims — against the risk indicators and security-verification checklist below. Every finding reported here was independently re-verified by direct code reading before being acted on; nothing was accepted on a sub-investigation's word alone.

## 2. Risk indicators (per the original Sprint 19 spec)

| Indicator | Status |
|---|---|
| Duplicate identity | Not detected at signup — disclosed gap, P3, see full completion report §"registration abuse" |
| Same bank across suspicious accounts | Not built — no cross-account bank-reference correlation exists |
| Suspicious device reuse | Not built — no device-fingerprint correlation exists |
| Agreement velocity | Not built |
| High-value velocity | **Built this sprint** — daily rolling-window amount/count limits (`transactionLimits.ts`) |
| Repeated payment failure | **Built this sprint** — `risk_event` signal on every failed webhook transition |
| Returns/chargebacks | Ledger-level reversal/return entry types exist and are deduped; no risk-signal correlation on top yet |
| Frequent bank changes | **Built this sprint** — `risk_event` signal on every real (non-idempotent) `replaceAccount` |
| Extreme settlement discounts | Not in this sprint's scope (settlement negotiation is a separate domain, Sprint 15) |
| Payout redirection | **Hardened this sprint** — MFA step-up now required on bank connection creation/replacement (previously missing despite `docs/SECURITY_MODEL.md` threat #16 requiring it) |
| Business activity through personal profile | Not in this sprint's scope (flagged in `docs/SECURITY_MODEL.md` §12 as a pre-existing design-level risk) |
| Unverifiable invitees | Existing invitation identity-binding (email/phone match) already covers this — re-verified sound |
| Account rings / circular payments / self-payments | Not built — no cross-account graph analysis exists |
| Collusion | Explicitly named in `docs/SECURITY_MODEL.md` §14 as an accepted residual risk, not preventable by design — unchanged |
| Account takeover | Re-verified sound — see full completion report §1 |

Responses supported by the new `risk_event` model (`src/lib/risk/riskEventService.ts`): flag, additional-verification-recommended (`challenge_recommended`), manual-review-recommended. No automated permanent ban or restriction is implemented — recording a signal never blocks the underlying action, per this sprint's own explicit instruction.

## 3. Security verification checklist (per the original Sprint 19 spec)

| Item | Result | Evidence |
|---|---|---|
| IDOR | **P0 found and fixed** | `PaymentService.submitPending` had no ownership check at all — fixed, tested at service and route layers (`paymentService.test.ts`, `ach/payments/submit/route.test.ts`, `debit-card/payments/submit/route.test.ts`) |
| RLS bypass | PASS | Deny-all-for-anon/authenticated pattern confirmed intact across all 36 migrations, including the two added this sprint |
| Privilege escalation | PASS | Admin self-promotion blocked, step-up required, no weaker admin financial-action path found |
| Session theft | PASS | httpOnly/Secure/SameSite cookies, server-side session revocation on logout, session-revocation-on-password-reset all confirmed |
| CSRF | PASS (SameSite=Lax) | No dedicated CSRF token; SameSite=Lax blocks cross-site POST — documented tradeoff, not a gap for this app's shape (no cross-origin form-post targets) |
| XSS | PASS | No `dangerouslySetInnerHTML`, no unsafe raw-HTML injection found |
| SQL injection | PASS | Drizzle ORM parameterizes all interpolated values; no raw string-built queries found |
| Webhook spoofing | PASS | Signature verification enforced (not just logged) on all three provider webhook types |
| Replay | PASS + hardened | Provider-event replay dedup confirmed atomic; **new this sprint**: a stale/out-of-order *different-event-type* webhook can no longer regress an already-terminal payment status |
| Rate-limit bypass | PASS | Differentiated per-operation limits confirmed (~25 call sites); documented fail-open on store failure is a pre-existing, protected, deliberate tradeoff, not a bypass |
| Document attack | Out of scope this pass (no document/evidence-upload change this sprint) |
| Secrets exposure | PASS | No hardcoded credentials found; server-only env schema confirmed architecturally sound |
| Tenant isolation | PASS + one fix | IDOR fix above was the one real tenant-isolation gap found |
| Payout modification | **P1 found and fixed** | MFA step-up was not enforced on bank-connection creation/replacement; a separate, more severe latent bug (insert-before-supersede ordering) would have broken every real production account replacement against the actual DB constraint — both fixed |

## 4. Provider-dependent items (cannot be verified without live providers)

- Twilio production OTP/SMS security (replay, brute-force, resend-abuse under a *live* Twilio account) — architecture verified sound against the sandbox; must be re-run after Twilio production activation.
- Live financial-provider webhook signature verification, production/test credential isolation — architecture verified sound against the sandbox; must be re-run after a live payment/KYC/banking provider is activated.

Full findings, severities, root causes, remediations, and regression evidence: `docs/sprints/SPRINT_19_COMPLETION_REPORT.md`.
