import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminUserDetail } from "@/components/AdminUserDetail";

export const metadata: Metadata = { title: "Admin | User" };

export default function AdminUserDetailPage() {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
        User
      </h1>
      <div style={{ marginTop: "1.5rem" }}>
        <Suspense fallback={<p role="status">Loading…</p>}>
          <AdminUserDetail />
        </Suspense>
      </div>
    </article>
  );
}
