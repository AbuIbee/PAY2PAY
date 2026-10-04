import type { Metadata } from "next";
import { OrganizationSettings } from "@/components/organizations/OrganizationSettings";

export const metadata: Metadata = { title: "Organization Settings" };

export default async function OrganizationSettingsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return (
    <div className="app-page">
      <OrganizationSettings organizationId={organizationId} />
    </div>
  );
}
