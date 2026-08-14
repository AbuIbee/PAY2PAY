import type { Metadata } from "next";
import { AdminDashboard } from "@/components/AdminDashboard";

export const metadata: Metadata = { title: "Admin" };

export default function AdminPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Admin dashboard</h1>
      </div>
      <AdminDashboard />
    </div>
  );
}
