import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { AdminVerificationQueue } from "@/components/admin/AdminVerificationQueue";

export const metadata: Metadata = { title: "Admin | Verification queue" };

export default function AdminVerificationPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Verification queue</h1>
      </div>
      <AdminGate>
        <AdminVerificationQueue />
      </AdminGate>
    </div>
  );
}
