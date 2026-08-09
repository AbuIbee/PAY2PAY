import type { Metadata } from "next";
import { AccountDashboard } from "@/components/AccountDashboard";

export const metadata: Metadata = { title: "Your account" };

export default function AccountPage() {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
        Your account
      </h1>
      <div style={{ marginTop: "1.5rem" }}>
        <AccountDashboard />
      </div>
    </article>
  );
}
