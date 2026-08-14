import type { Metadata } from "next";
import { AdminGate } from "@/components/admin/AdminGate";
import { AdminLedger } from "@/components/admin/AdminLedger";

export const metadata: Metadata = { title: "Admin | Ledger" };

export default function AdminLedgerPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Ledger</h1>
      </div>
      <AdminGate>
        <AdminLedger />
      </AdminGate>
    </div>
  );
}
