import { AppNav } from "@/components/AppNav";
import { AdminImpersonationBanner } from "@/components/admin/AdminImpersonationBanner";
import "./app-shell.css";

/**
 * Sprint 18B: the authenticated product shell — distinct from the marketing
 * site's shell in (marketing)/layout.tsx. Server-authoritative pages behind
 * this layout still each independently check the session (this layout adds
 * no authorization of its own, matching every other page in this codebase's
 * "server remains authoritative" convention) — AppNav is presentation only.
 *
 * PRSprint 11B: AdminImpersonationBanner is mounted here, not on any single admin page, so an
 * active support view stays visible and endable from anywhere in the authenticated app — see its
 * own doc comment for why (closing the "hidden persistent support session" gap).
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-authed">
      <AppNav />
      <div className="app-main-col">
        <AdminImpersonationBanner />
        <main id="main-content">{children}</main>
      </div>
    </div>
  );
}
