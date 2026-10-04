# Owner Launch Actions

"PAID2YOU — MASTER P0" (2026-10-03), Section 63. Tasks the code in this repository cannot complete —
every item below needs a human with account access, legal authority, or deployment credentials this
session does not have and should not be given. No secret values are given here, ever — only
variable **names** and what they're for. Severity: **P0** = blocks a controlled first Business;
**P1** = needed before a wider launch but not before the controlled first Business.

## Middesk (business verification)

| Item | Why required | System | Config variable | How to verify success | Priority |
|---|---|---|---|---|---|
| Create/approve a Middesk production account | No Middesk account exists | Middesk dashboard | — | Able to log in to Middesk's dashboard | P0 |
| Obtain a production API key | `MiddeskBusinessVerificationProvider` needs it | Middesk dashboard → API keys | `MIDDESK_API_KEY` | `npm run production-readiness` reports `MIDDESK: CONFIGURED` once set alongside the webhook secret below | P0 |
| Register a production webhook endpoint pointing at `https://<your-domain>/api/webhooks/business-verification/middesk` | Async verification results only arrive this way | Middesk dashboard → Webhooks (or `POST /webhooks` API) | — | A test business created in Middesk's own test mode triggers a delivery your logs show arriving at this route | P0 |
| Obtain that webhook's signing secret | Required to verify `X-Middesk-Signature-256` | Middesk dashboard → Webhooks | `MIDDESK_WEBHOOK_SECRET` | Same as above — a genuine delivery verifies; a tampered one is rejected (403) | P0 |
| Set `BUSINESS_VERIFICATION_PROVIDER=middesk` in the deployment environment | Selects the real adapter, not "unavailable" | Vercel (or host) env vars | `BUSINESS_VERIFICATION_PROVIDER` | `npm run production-readiness` reports `MIDDESK: CONFIGURED` | P0 |
| Decide the manual-review policy for an `in_review` business | Middesk surfaces findings for a human to approve/reject — this repo does not auto-decide (Section 16) | Middesk dashboard (reviewer) | — | A controlled first Business that reaches `in_review` gets a real human decision, not a stuck/silent state | P0 |

## Stripe Billing (Paid2You's own subscription billing — never customer repayment)

| Item | Why required | System | Config variable | How to verify success | Priority |
|---|---|---|---|---|---|
| Confirm the Stripe account is production-ready (business details, bank account for payouts to Paid2You) | No live charges can settle otherwise | Stripe dashboard | — | Stripe dashboard shows "Account activated" | P0 |
| Create 4 live Products/Prices: Starter $99/mo, Core $199/mo, Growth $699/mo, Scale $1,999/mo | `StripePlatformBillingProvider.requirePriceId` needs a real Price ID per plan | Stripe dashboard → Products | `STRIPE_STARTER_PRICE_ID`, `STRIPE_CORE_PRICE_ID`, `STRIPE_GROWTH_PRICE_ID`, `STRIPE_SCALE_PRICE_ID` | `npm run production-readiness` only checks the secret/webhook pair today — confirm price IDs manually by attempting a real Starter checkout in Days 4-5 and watching it succeed | P0 |
| **Deliberately do NOT create an Enterprise Price** | Section 21: no automatic Enterprise self-service checkout | Stripe dashboard | (none) | Enterprise stays rejected by `change-plan`/onboarding routes regardless of Stripe state | P0 (as a "don't") |
| Obtain a production secret key | `StripePlatformBillingProvider` needs it | Stripe dashboard → Developers → API keys | `STRIPE_SECRET_KEY` | `npm run production-readiness` reports `STRIPE_BILLING: CONFIGURED` once set alongside the webhook secret | P0 |
| Register a production webhook endpoint at `https://<your-domain>/api/webhooks/billing/stripe`, subscribed at minimum to `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed` | Subscription/invoice sync depends on it | Stripe dashboard → Developers → Webhooks | — | Stripe's dashboard shows successful (2xx) recent deliveries once a real subscription event fires | P0 |
| Obtain that webhook's signing secret | Required for `stripe.webhooks.constructEvent` | Stripe dashboard → Webhooks | `STRIPE_WEBHOOK_SECRET` | Same as above | P0 |
| Configure the Stripe Customer Portal (used by "Change Payment Method") to expose ONLY payment-method update — not plan switching or cancellation through Stripe's own UI | Section 29/31: this application remains the sole authority over plan changes/cancellation | Stripe dashboard → Settings → Billing → Customer portal | — | Opening the portal link as a test customer shows only a payment-method-update option | P0 |
| Set `PLATFORM_BILLING_PROVIDER=stripe` in the deployment environment | Selects the real adapter | Vercel (or host) env vars | `PLATFORM_BILLING_PROVIDER` | `npm run production-readiness` reports `STRIPE_BILLING: CONFIGURED` | P0 |

## Resend (transactional email)

| Item | Why required | System | Config variable | How to verify success | Priority |
|---|---|---|---|---|---|
| Confirm/obtain a production Resend API key | `ResendEmailSender` needs it | Resend dashboard | `RESEND_API_KEY` | `npm run production-readiness` reports `RESEND: CONFIGURED` | P0 |
| Verify the sending domain (SPF/DKIM DNS records) | Unverified-domain mail is unreliable/spam-flagged | Your DNS provider + Resend dashboard → Domains | — | Resend dashboard shows the domain status as "Verified" | P0 |
| Set the production "from" address | `getEmailSender.ts` requires it once a key is present | Deployment env vars | `EMAIL_FROM_ADDRESS` (and optionally `EMAIL_FROM_NAME`) | A real staff-invitation email in Days 4-5 arrives from the expected address, not bounced | P0 |
| Register the Resend delivery-status webhook (optional for launch, useful for observability) | Delivery/bounce/open tracking | Resend dashboard → Webhooks | `RESEND_WEBHOOK_SECRET` | `src/app/api/webhooks/email/resend/route.ts` accepts a real delivery | P1 |

**Launch stop condition:** if the sending domain is not verified, do not proceed past Day 4's
"invite a controlled employee" step — an unverified domain risks the invitation email never
arriving or landing in spam, which would make the controlled acceptance test misleading.

## Supabase Storage (agreement/document storage)

| Item | Why required | System | Config variable | How to verify success | Priority |
|---|---|---|---|---|---|
| Confirm the production Supabase project exists and is not paused | `SupabaseDocumentStorage` needs a live project | Supabase dashboard | — | Project status shows active | P0 |
| Confirm the `agreement-pdfs` bucket exists as a PRIVATE bucket | `AGREEMENT_PDF_BUCKET` constant assumes this exact name/privacy | Supabase dashboard → Storage | — | Bucket listed, "Public" toggle OFF | P0 |
| Obtain the production project URL and service-role key | `SupabaseDocumentStorage` needs both | Supabase dashboard → Settings → API | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `npm run production-readiness` reports `SUPABASE_STORAGE: CONFIGURED` | P0 |

## Deployment / platform

| Item | Why required | System | Config variable | How to verify success | Priority |
|---|---|---|---|---|---|
| Set the production domain and point DNS at the deployment | `APP_URL`'s own `superRefine` check refuses to serve production traffic on localhost | Your DNS provider + Vercel (or host) | `APP_URL` | A request to the real domain succeeds; `npm run production-readiness` reports `DATABASE`/overall checks correctly once all vars are set | P0 |
| Set `APP_ENV=production` in the deployed environment | Gates every fail-closed production behavior in this codebase, including `npm run production-readiness`'s own `BUSINESS_PLATFORM` check — "PAID2YOU — CODEX P0 DEFECT REMEDIATION" (2026-10-04), P0-7: a non-production `APP_ENV`, or an `APP_URL` that resolves to localhost, now correctly reports `CONFIGURATION_INCOMPLETE` rather than a false `READY` | Vercel (or host) env vars | `APP_ENV` | `npm run production-readiness` run against that environment's own vars shows `BUSINESS_PLATFORM: CONFIGURATION_READY` (NOT the old bare "READY" — that value no longer exists) once every required variable, including all 4 Stripe standard-plan Price IDs, is genuinely present; `LIVE_VERIFIED` always reads `NO` from this command alone — only an actual smoke test / first live Business proves that | P0 |
| Enter all secrets above into the deployment platform's environment-variable store | Nothing above functions without this | Vercel (or host) env vars | (all above) | `vercel env ls` (or equivalent) lists the expected variable NAMES — never print values | P0 |
| Authorize the actual production deployment | Claude is not authorized to deploy | Vercel (or host) | — | Deployment dashboard shows the new build live | P0 |

## Legal / owner review

| Item | Why required | System | Config variable | How to verify success | Priority |
|---|---|---|---|---|---|
| Review `docs/PRODUCTION_LEGAL_REVIEW.md` and decide each flagged item | Only the owner (or counsel, if engaged) can approve legal/commercial language | — | — | Owner sign-off recorded (outside this repository, or as an explicit follow-up instruction) | P0 |
| Decide the nonpayment → suspension timeline referenced in that review | No code currently implements automatic suspension — the policy text describes a consequence with no trigger yet | — | — | Either accepted as a known gap for the controlled first Business, or a follow-up phase is explicitly requested | P0 |

## Direct Banking (explicitly NOT part of this launch)

| Item | Why required | Priority |
|---|---|---|
| Any FedNow/RTP/Request for Payment onboarding, bank account linkage, or production credentials | Out of scope for this worktree per the 2026-10-03 "SENIOR ARCHITECT CONTROL AMENDMENT — PHASE 3B BOUNDARY" — a separately controlled production workstream | N/A — do not start this yet |
