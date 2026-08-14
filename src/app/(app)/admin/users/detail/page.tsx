import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminUserDetail } from "@/components/AdminUserDetail";

export const metadata: Metadata = { title: "Admin | User" };

export default function AdminUserDetailPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>User</h1>
      </div>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <AdminUserDetail />
      </Suspense>
    </div>
  );
}
