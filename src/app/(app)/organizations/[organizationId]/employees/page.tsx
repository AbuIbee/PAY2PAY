import type { Metadata } from "next";
import { OrganizationEmployeesTabs } from "@/components/organizations/OrganizationEmployeesTabs";

export const metadata: Metadata = { title: "Employees" };

export default async function OrganizationEmployeesPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return (
    <div className="app-page">
      <OrganizationEmployeesTabs organizationId={organizationId} />
    </div>
  );
}
