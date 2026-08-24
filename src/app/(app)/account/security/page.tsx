import type { Metadata } from "next";
import { AccountSecurity } from "@/components/AccountSecurity";

export const metadata: Metadata = { title: "Security" };

export default function AccountSecurityPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>Security</h1>
          <p className="app-page__lede">
            Manage two-factor authentication and see every device currently signed in to your account.
          </p>
        </div>
      </div>
      <AccountSecurity />
    </div>
  );
}
