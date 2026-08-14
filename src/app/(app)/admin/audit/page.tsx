import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { AdminAuditLog } from "@/components/admin/AdminAuditLog";

export const metadata: Metadata = { title: "Admin | Audit log" };

export default function AdminAuditPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Audit log</h1>
      </div>
      <AdminGate>
        <AdminAuditLog />
      </AdminGate>
    </div>
  );
}
