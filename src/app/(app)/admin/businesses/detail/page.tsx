import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminBusinessDetail } from "@/components/admin/AdminBusinessDetail";

export const metadata: Metadata = { title: "Admin | Business" };

export default function AdminBusinessDetailPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Business</h1>
      </div>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <AdminBusinessDetail />
      </Suspense>
    </div>
  );
}
