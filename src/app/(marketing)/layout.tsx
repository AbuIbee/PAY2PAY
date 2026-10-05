import Link from "next/link";
import { AuthNavCta } from "@/components/AuthNavCta";
import { MobileNavToggle } from "@/components/MobileNavToggle";

function Wordmark() {
  return (
    <span className="brand-word">
      <span className="brand-word__dark">Paid2</span>
      <span className="brand-word__accent">You</span>
    </span>
  );
}

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-inner">
          <Link className="brand" href="/" aria-label="Paid2You home">
            <Wordmark />
          </Link>
          <MobileNavToggle />
          <div className="header-actions">
            <AuthNavCta />
          </div>
        </div>
      </header>
      <main id="main-content" className="app-main">
        <div className="container">{children}</div>
      </main>
      <footer className="app-footer">
        <div className="footer-inner">
          <div className="footer-inner__brand">
            <Link className="brand brand--footer" href="/">
              <Wordmark />
            </Link>
            <p>Moving business forward.</p>
            <small>© 2026 Paid2You.</small>
          </div>
          <nav aria-label="Footer navigation">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/accessibility">Accessibility</Link>
            <Link href="/support">Support</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
