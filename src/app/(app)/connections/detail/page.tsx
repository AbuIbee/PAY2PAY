import type { Metadata } from "next";
import { Suspense } from "react";
import { ConnectionDetail } from "@/components/ConnectionDetail";

export const metadata: Metadata = { title: "Connection" };

export default function ConnectionDetailPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Connection</h1>
      </div>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <ConnectionDetail />
      </Suspense>
    </div>
  );
}
