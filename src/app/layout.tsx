import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Paid2You | Clear, Interest-Free Repayment Agreements",
    template: "%s | Paid2You",
  },
  description: "Create clear, interest-free repayment agreements for personal debts, customer payment plans, and business receivables.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#082f2b",
};

/**
 * Sprint 18B: the marketing site and the authenticated product now have
 * distinct shells — (marketing)/layout.tsx keeps the original public
 * header/footer, (app)/layout.tsx is the new authenticated nav — so this
 * root layout only supplies the document skeleton both share.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
