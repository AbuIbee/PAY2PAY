import type { Metadata } from "next";
import { Suspense } from "react";
import { AgreementInvitationReview } from "@/components/AgreementInvitationReview";

export const metadata: Metadata = { title: "Payment plan proposal" };

/**
 * PRSprint 10 (docs/prsprints/PRSPRINT_10_INVITATION_IDENTITY_CLAIMING_ACCEPTANCE.md): the
 * anonymous-review deep link — `https://paid2you.com/i/<opaque-random-token>`. Lives under
 * (marketing) (route groups are stripped from the URL, so this still resolves to `/i/<token>`)
 * rather than (app) — no authenticated shell/nav, since a first-time recipient has no session yet.
 * All actual data fetching happens client-side against the public resolve endpoint; this server
 * component never touches the token itself, so an automated crawler indexing this page's HTML
 * shell never sees anything sensitive.
 */
export default async function AgreementInvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <AgreementInvitationReview token={token} />
      </Suspense>
    </article>
  );
}
