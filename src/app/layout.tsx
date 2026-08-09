import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { MobileNavToggle } from "@/components/MobileNavToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "PAY2PAY | Clear, Interest-Free Repayment Agreements",
    template: "%s | PAY2PAY",
  },
  description: "Create clear, interest-free repayment agreements for personal debts, customer payment plans, and business receivables.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#082f2b",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <div className="app-shell">
          <header className="app-header">
            <div className="header-inner">
              <Link className="brand" href="/" aria-label="PAY2PAY home">
                <span className="brand-mark" aria-hidden="true"><i>P</i><i>2</i></span>
                <span>PAY2PAY</span>
              </Link>
              <MobileNavToggle />
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
              <small>© 2026 PAY2PAY. Product preview—financial functionality is not yet enabled.</small>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
