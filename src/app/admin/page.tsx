import type { Metadata } from "next";
import { AdminDashboard } from "@/components/AdminDashboard";

export const metadata: Metadata = { title: "Admin" };

export default function AdminPage() {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
        Admin dashboard
      </h1>
      <div style={{ marginTop: "1.5rem" }}>
        <AdminDashboard />
      </div>
    </article>
  );
}
