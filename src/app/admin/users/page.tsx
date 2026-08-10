import type { Metadata } from "next";
import { AdminUsers } from "@/components/AdminUsers";

export const metadata: Metadata = { title: "Admin | Users" };

export default function AdminUsersPage() {
  return (
    <article className="section" style={{ paddingBlockStart: "2.5rem" }}>
      <h1 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "var(--text-2xl)", fontWeight: 500 }}>
        Users
      </h1>
      <div style={{ marginTop: "1.5rem" }}>
        <AdminUsers />
      </div>
    </article>
  );
}
