import type { Metadata } from "next";
import { OrganizationUnavailableResource } from "@/components/organizations/OrganizationUnavailableResource";

export const metadata: Metadata = { title: "Integrations" };

export default async function OrganizationIntegrationsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return (
    <div className="app-page">
      <OrganizationUnavailableResource
        organizationId={organizationId}
        permissionKey="integrations.view"
        title="Integrations"
        message="No integrations are available yet."
      />
    </div>
  );
}
