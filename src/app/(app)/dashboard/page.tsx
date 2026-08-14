import type { Metadata } from "next";
import { Dashboard } from "@/components/Dashboard";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Dashboard</h1>
      </div>
      <Dashboard />
    </div>
  );
}
