import type { Metadata } from "next";
import { Suspense } from "react";
import { PreferredEmailVerifyStatus } from "@/components/PreferredEmailVerifyStatus";

export const metadata: Metadata = { title: "Verify preferred email" };

export default function ProfileVerifyEmailPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>Verify your preferred email</h1>
        </div>
      </div>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <PreferredEmailVerifyStatus />
      </Suspense>
    </div>
  );
}
