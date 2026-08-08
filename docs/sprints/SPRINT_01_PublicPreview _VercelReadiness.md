Read all project governance and specification documents.

SPRINT 1 OBJECTIVE:
Prepare PAY2PAY for a public presentation deployment through GitHub + Vercel.

This is NOT a financial production launch.

The public deployment must allow investors, attorneys, processor representatives,
businesses, partners, and potential beta users to understand the product.

Required work:

1. Verify production build compatibility with Vercel.

2. Verify:
   - no local filesystem dependencies;
   - no hard-coded localhost URLs;
   - no development-only secrets required for rendering the public landing page;
   - no private keys in source;
   - no production financial credentials.

3. Create environment-variable documentation:
   docs/ENVIRONMENT_VARIABLES.md

Classify variables as:
   - local development
   - preview
   - staging
   - production
   - server-only
   - client-safe

4. Ensure the marketing site can operate without a live payment processor.

5. Create a functional Early Access CTA.

The early-access form should collect:
   - name
   - email
   - individual/business
   - business name when applicable
   - state
   - intended use
   - approximate number of agreements per month
   - optional notes

Do NOT collect:
   - bank account
   - routing number
   - SSN
   - EIN unless genuinely necessary later
   - payment card
   - government ID

6. Store early-access submissions safely using an approved Supabase table.

Create:
   early_access_leads

Required fields:
   id
   name
   email
   account_type
   business_name nullable
   state
   intended_use
   expected_agreements_per_month
   notes nullable
   created_at
   source
   consent_version

7. Implement database migration and RLS.

Public visitors may INSERT only through the controlled application path.

They must not be able to SELECT the table.

8. Add abuse protection:
   - server validation
   - rate limiting
   - honeypot or comparable basic bot control
   - duplicate handling

9. Add:
   - success state
   - validation errors
   - failure state

10. Add footer routes/placeholders:
   /privacy
   /terms
   /accessibility
   /support

Do not fabricate final legal text.
Clearly mark legally unfinished content internally for review.

11. Maintain current presentation design unless changes are required for the CTA.

12. Verify:
   npm run lint
   npm run typecheck
   npm test
   npm run build

13. Update docs/PROGRESS.md.

Acceptance criteria:

- Vercel build succeeds.
- Landing page renders without financial services enabled.
- Early-access form works against Supabase.
- Anonymous users cannot query lead data.
- No secrets appear in browser bundle.
- No false claims that real payments are available.
- No payment functionality is implemented.
- Git working tree is clean after approved commit.

Stop after Sprint 1.
Do not begin authentication.