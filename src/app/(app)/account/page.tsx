import type { Metadata } from "next";
import { AccountDashboard } from "@/components/AccountDashboard";

export const metadata: Metadata = { title: "Your account" };

export default function AccountPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Your account</h1>
      </div>
      <AccountDashboard />
    </div>
  );
}
