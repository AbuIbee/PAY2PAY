import type { Metadata } from "next";
import { OrganizationUnavailableResource } from "@/components/organizations/OrganizationUnavailableResource";

export const metadata: Metadata = { title: "Reports" };

export default async function OrganizationReportsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return (
    <div className="app-page">
      <OrganizationUnavailableResource organizationId={organizationId} permissionKey="reports.view" title="Reports" message="No reports are available yet." />
    </div>
  );
}
