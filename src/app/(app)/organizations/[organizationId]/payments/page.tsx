import type { Metadata } from "next";
import { OrganizationUnavailableResource } from "@/components/organizations/OrganizationUnavailableResource";

export const metadata: Metadata = { title: "Payments" };

export default async function OrganizationPaymentsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return (
    <div className="app-page">
      <OrganizationUnavailableResource
        organizationId={organizationId}
        permissionKey="payments.view"
        title="Payments"
        message="Organization-level payment activity isn't available here yet. View individual agreements for their payment details."
      />
    </div>
  );
}
