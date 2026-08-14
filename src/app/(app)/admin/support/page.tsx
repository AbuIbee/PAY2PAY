import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { AdminSupportQueue } from "@/components/admin/AdminSupportQueue";

export const metadata: Metadata = { title: "Admin | Support queue" };

export default function AdminSupportPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Support queue</h1>
      </div>
      <AdminGate>
        <AdminSupportQueue />
      </AdminGate>
    </div>
  );
}
