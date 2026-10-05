import Link from "next/link";
import { AuthNavCta } from "@/components/AuthNavCta";
import { MobileNavToggle } from "@/components/MobileNavToggle";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-inner">
          <Link className="brand" href="/" aria-label="PAY2PAY home">
            <span className="brand-mark" aria-hidden="true"><i>P</i><i>2</i></span>
            <span>PAY2PAY</span>
          </Link>
          <div style={{ marginInlineStart: "auto", display: "flex", alignItems: "center" }}>
            <AuthNavCta />
            <MobileNavToggle />
          </div>
        </div>
      </header>
      <main id="main-content" className="app-main">
        <div className="container">{children}</div>
      </main>
      <footer className="app-footer">
        <div className="footer-inner">
          <Link className="brand brand--footer" href="/">
            <span className="brand-mark" aria-hidden="true"><i>P</i><i>2</i></span>
            <span>PAY2PAY</span>
          </Link>
          <p>Clear terms. Mutual approval. Documented repayment.</p>
          <nav aria-label="Footer navigation">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/support">Support</Link>
            <Link href="/accessibility">Accessibility</Link>
          </nav>
          <small>© 2026 PAY2PAY.</small>
        </div>
      </footer>
    </div>
  );
}
