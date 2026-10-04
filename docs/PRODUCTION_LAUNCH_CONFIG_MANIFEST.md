# Production Launch Configuration Manifest

"PAID2YOU PRODUCTION LAUNCH" Phase 2, Section 22. Names only — **never values**. Generated from a
direct read of `src/config/env.ts` (the single source of truth for every server-only environment
variable this application validates at startup/first-use). Kept in sync with that file; if a variable
is added/removed there, update this manifest in the same change.

> **PAID2YOU OWNER DIRECTIVE (2026-10-03) — ADYEN RETIRED.** Every `ADYEN_*` row below is historical
> record of a now-retired direction, not a live configuration target — `PROVIDER_CAPABILITY_REGISTRY`
> (`src/lib/providers/providerCapabilities.ts`) is empty, so none of these variables can activate
> anything in this application regardless of whether they are set. **No `ADYEN_*` variable may ever be
> configured in a Paid2You environment going forward.** The owner-approved direction — Direct Banking
> Connectivity (FedNow/RTP/Request for Payment) for repayment money movement, Stripe Billing for
> Paid2You's own subscription billing, Middesk for Business verification — has not yet been implemented,
> so none of those vendors have environment variables to list here yet either. This manifest will gain
> new LAUNCH_REQUIRED/FEATURE_REQUIRED rows for them only once their respective implementation phases
> (3A/3B) are explicitly authorized and underway.

Categories:

- **BOOT_REQUIRED** — the application cannot safely serve any request without this.
- **LAUNCH_REQUIRED** — needed to complete the minimum real-Business path described in Phase 1/2
  (verification → subscription → billing → legal acceptance); the app boots without it, but the
  corresponding feature fails closed with an honest "not available" state.
- **FEATURE_REQUIRED** — needed only if a specific, named feature is turned on; absence fails closed
  for that feature alone, nothing else.
- **OPTIONAL** — safe default exists; no feature fails closed because it's unset.
- **DISABLED_FOR_INITIAL_LAUNCH** — deliberately left unset/false; for the Adyen-specific rows below,
  this is now a **permanent prohibition** (2026-10-03 owner directive — "ADYEN RETIRED"), not merely a
  this-launch deferral (superseding the earlier Phase 2, Section 28 "Do not enable Adyen" framing).
  Flipping any of these is a deliberate, separate, later decision — never a side effect of this phase —
  and for Adyen specifically, never without explicit written owner authorization at all.

## BOOT_REQUIRED

| Variable | Why |
|---|---|
| `DATABASE_URL` | No request that touches the database (effectively every route) can function without it. |
| `AUDIT_HASH_SECRET` | Required wherever audit-logged code paths run — most mutating routes. |
| `AUTH_PASSWORD_PEPPER` | Required wherever authentication runs — every session-gated route. |
| `APP_URL` | Has a localhost default for local dev only; a dedicated startup check (`src/config/env.ts`'s `superRefine`) refuses to serve any request when `APP_ENV=production` and this still resolves to localhost or an unconfigured value. |
| `APP_ENV` | Has a default (`development`); production behavior (fail-closed email/SMS, provider gating, the `APP_URL` check above) all key off this being explicitly `production`. |

## LAUNCH_REQUIRED (minimum real-Business path)

| Variable | Why | Current status |
|---|---|---|
| `BUSINESS_VERIFICATION_PROVIDER` | Selects the live Business verification provider; unset = `ProviderNotAvailableError`, verification stays pending indefinitely. | Unset — no vendor chosen (Phase 2, Section 28: not this phase's decision to make). |
| `PLATFORM_BILLING_PROVIDER` | Selects the live Paid2You subscription billing provider; unset = `ProviderNotAvailableError`, subscription activation/payment-method/invoices stay unavailable. | Unset — no vendor chosen. |
| `RESEND_API_KEY` / `EMAIL_FROM_ADDRESS` | Without both, production email (invitations, verification, legal-acceptance confirmations) fails closed rather than silently logging to console (see `getEmailSender.ts`'s pre-existing `failClosed` behavior, already tested). | Not confirmed present in this worktree's deployed environment — operator to verify. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Signed agreement PDF storage/retrieval fails closed without both (`SupabaseDocumentStorage`). Only blocking if the launch surface depends on document generation/retrieval — confirm against the actual initial feature set before treating as a hard blocker. | Not confirmed present — operator to verify. |

## FEATURE_REQUIRED (only if that specific feature is turned on)

| Variable | Feature |
|---|---|
| ~~`ADYEN_API_KEY`, `ADYEN_MERCHANT_ACCOUNT`, `ADYEN_LIVE_PREFIX`, `ADYEN_PAYMENTS_HMAC_KEY`~~ | **RETIRED (2026-10-03, owner directive).** Formerly: real customer-repayment ACH debit via Adyen (`PAYMENT_PROVIDER=adyen`). `PROVIDER_CAPABILITY_REGISTRY` is empty — setting these now does nothing, and none may ever be configured in any Paid2You environment. Kept here only as a historical record of a retired row. |
| ~~`ADYEN_RECURRING_HMAC_KEY`~~ | **RETIRED (2026-10-03, owner directive).** Formerly: Adyen bank-account tokenization lifecycle webhook specifically. Same status as above. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER` | Production SMS delivery; without these, SMS fails closed in production (same pattern as email, already tested) rather than claiming delivery. SMS itself remains deferred unless explicitly authorized for launch. |
| `RESEND_WEBHOOK_SECRET` | Email delivery-status (bounce/open/click) tracking via Resend's webhook. |
| `CRON_SECRET` | Vercel Cron-triggered scheduled jobs (e.g. failed-payment retry) — required only once those jobs are actually scheduled against a deployed environment. |

**Owner-approved direction, not yet implemented — no environment variables exist for these yet.** None
of the following have adapter code, a registry entry, or a schema entry in `src/config/env.ts` as of
this phase; this row exists only to record intent, not to declare a requirement:
- **Direct Banking Connectivity** (FedNow / RTP / Request for Payment) — repayment money movement.
  Phase 3B. This B2B worktree is explicitly not authorized to implement the rail itself (per the
  2026-10-03 "SENIOR ARCHITECT CONTROL AMENDMENT — PHASE 3B BOUNDARY"); only the consuming
  integration boundary (interfaces/contracts the Business app will call once an independently approved
  banking capability exists) is in scope here, and even that boundary must keep repayment/payment
  initiation hidden or disabled until independent banking production acceptance occurs.
- **Stripe Billing** — Paid2You's own subscription billing. Phase 3A.
- **Middesk** — Business verification. Phase 3A.

## OPTIONAL

| Variable | Why it's safe to leave unset |
|---|---|
| `NEXT_PUBLIC_APP_NAME` | Cosmetic; has a default (`PAY2PAY`). |
| `NEXT_PUBLIC_APP_ENV` | Cosmetic/client-side display; has a default. |
| `EMAIL_FROM_NAME` | Has a default (`PAY2PAY`). |
| `EMAIL_DELIVERY_ENABLED` | Defaults to enabled; an operational kill switch, not a launch blocker. |
| `SMS_DELIVERY_ENABLED` | Defaults to enabled; same as above for SMS. |
| `FEATURE_<FLAG_NAME>` (e.g. `FEATURE_LIVE_BANKING_ENABLED`) | Per-environment override of a hard-coded, safe default in `src/lib/feature-flags.ts`. |
| ~~`NEXT_PUBLIC_ADYEN_CLIENT_KEY`~~ | **RETIRED (2026-10-03, owner directive).** Formerly: only needed once a client-side Adyen component is actually rendered. No client-side Adyen component may be rendered going forward; this variable must never be configured. |

## DISABLED_FOR_INITIAL_LAUNCH

| Variable | Why it stays unset/false this launch window |
|---|---|
| `PAYMENT_PROVIDER` (`=adyen`) | **Permanently prohibited, not merely deferred** (2026-10-03 owner directive: "ADYEN RETIRED" — supersedes the earlier Phase 2 "Do not enable Adyen" instruction with a permanent ban). `PROVIDER_CAPABILITY_REGISTRY` is empty, so this value can no longer activate anything regardless of being set. Real customer repayment money-movement is not part of any launch until Direct Banking Connectivity (Phase 3B) is independently approved and built — see the FEATURE_REQUIRED section above. |
| `KYC_PROVIDER`, `CARD_ISSUING_PROVIDER` | No vendor selected; not required for the initial Business launch surface (Dashboard/Balances/Customers/Agreements/Employees/Settings/Billing). |
| ~~`ADYEN_PAYMENTS_VERIFIED`~~ | **RETIRED (2026-10-03, owner directive).** Formerly: a second, independent operator-only confirmation gate on top of `PAYMENT_PROVIDER=adyen`. No longer meaningful — Adyen cannot be activated by any variable now. |
| ~~`ADYEN_ACH_TOKENIZATION_VERIFIED`~~ | **RETIRED (2026-10-03, owner directive).** Formerly: external-blocker gate (Adyen Support + GIACT) for bank-account tokenization. `getBankConnectionService()` fails closed regardless of this flag's value now — bank-linking has no live path at all pending Direct Banking Connectivity (Phase 3B). |
| `PAYOUT_PROVIDER_INTEGRATION_VERIFIED` | No live payout provider integration exists — stays `false`. |

## Verification without reading values

To confirm which of the above are actually set in a given deployed environment **without printing
any value**: `vercel env ls` (lists variable **names** and which environments they're attached to,
never values) or the hosting platform's equivalent "list configured environment variable names" view.
Never paste `.env` contents or secret values into a report, a commit, or this document.
