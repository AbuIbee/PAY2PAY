import { AppNav } from "@/components/AppNav";
import "./app-shell.css";

/**
 * Sprint 18B: the authenticated product shell — distinct from the marketing
 * site's shell in (marketing)/layout.tsx. Server-authoritative pages behind
 * this layout still each independently check the session (this layout adds
 * no authorization of its own, matching every other page in this codebase's
 * "server remains authoritative" convention) — AppNav is presentation only.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-authed">
      <AppNav />
      <div className="app-main-col">
        <main id="main-content">{children}</main>
      </div>
    </div>
  );
}
