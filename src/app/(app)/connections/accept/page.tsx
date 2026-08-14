import type { Metadata } from "next";
import { Suspense } from "react";
import { AcceptDeclineInvitation } from "@/components/AcceptDeclineInvitation";

export const metadata: Metadata = { title: "Respond to invitation" };

export default function ConnectionAcceptPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Connection invitation</h1>
      </div>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <AcceptDeclineInvitation />
      </Suspense>
    </div>
  );
}
