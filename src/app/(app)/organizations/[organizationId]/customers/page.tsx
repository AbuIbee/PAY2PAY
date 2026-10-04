import type { Metadata } from "next";
import { OrganizationCustomers } from "@/components/organizations/OrganizationCustomers";

export const metadata: Metadata = { title: "Customers" };

export default async function OrganizationCustomersPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return (
    <div className="app-page">
      <OrganizationCustomers organizationId={organizationId} />
    </div>
  );
}
