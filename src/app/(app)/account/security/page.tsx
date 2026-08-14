import type { Metadata } from "next";
import { AccountSecurity } from "@/components/AccountSecurity";

export const metadata: Metadata = { title: "Security" };

export default function AccountSecurityPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Security</h1>
      </div>
      <AccountSecurity />
    </div>
  );
}
