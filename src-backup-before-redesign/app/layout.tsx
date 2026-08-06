import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { MobileNavToggle } from "@/components/MobileNavToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "PAY2PAY",
    template: "%s | PAY2PAY",
  },
  description: "Ethical, interest-free repayment agreements.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0f4c3a",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <div className="app-shell">
          <header className="app-header">
            <Link className="brand" href="/">
              PAY2PAY
            </Link>
            <MobileNavToggle />
          </header>
          <main id="main-content" className="app-main">
            <div className="container">{children}</div>
          </main>
          <footer className="app-footer">
            <div className="container">
              <p>PAY2PAY — foundation build. No live agreements or payments yet.</p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
