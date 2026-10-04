import type { Metadata } from "next";
import { OrganizationDashboard } from "@/components/organizations/OrganizationDashboard";

export const metadata: Metadata = { title: "Business Dashboard" };

export default async function OrganizationDashboardPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return (
    <div className="app-page">
      <OrganizationDashboard organizationId={organizationId} />
    </div>
  );
}
