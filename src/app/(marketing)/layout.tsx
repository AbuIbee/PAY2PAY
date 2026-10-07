import Link from "next/link";
import { AuthNavCta } from "@/components/AuthNavCta";
import { MobileNavToggle } from "@/components/MobileNavToggle";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-inner">
          <Link className="paid2you-wordmark" href="/" aria-label="Paid2You home"><span>Paid2</span><strong>You</strong></Link>
          <MobileNavToggle />
          <div className="marketing-header-actions"><AuthNavCta /><Link className="button button--primary" href="/signup?accountType=business">Get Started</Link></div>
        </div>
      </header>
      <main id="main-content" className="app-main"><div className="container">{children}</div></main>
      <footer className="app-footer"><div className="footer-inner paid2you-footer"><div><Link className="paid2you-wordmark paid2you-wordmark--footer" href="/"><span>Paid2</span><strong>You</strong></Link><p>Business-first account tools. Personal when you need it.</p></div><nav aria-label="Footer navigation"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/accessibility">Accessibility</Link><Link href="/support">Support</Link></nav><small>Â© 2026 Paid2You.</small></div></footer>
    </div>
  );
}
