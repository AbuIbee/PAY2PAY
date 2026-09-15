import type { Metadata } from "next";
import { PublicSupport } from "@/components/PublicSupport";

export const metadata: Metadata = { title: "Support" };

/**
 * B0-A (public-surface remediation): this route is reachable by anonymous visitors (the public
 * marketing footer links here, and there is no middleware/session gate in this repository — see
 * PublicSupport.tsx's own doc comment). It previously rendered SupportAppeals directly, which fetched
 * an authenticated-only endpoint on load and showed a generic failure to a logged-out visitor.
 * PublicSupport renders real, safe, unauthenticated content immediately and only shows the
 * authenticated appeals experience once a session is actually confirmed.
 */
export default function SupportPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>Support</h1>
          <p className="app-page__lede">Find the right way to get help, or appeal an account decision.</p>
        </div>
      </div>
      <PublicSupport />
    </div>
  );
}
