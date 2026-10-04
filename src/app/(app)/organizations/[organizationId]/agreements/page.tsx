import type { Metadata } from "next";
import { OrganizationAgreements } from "@/components/organizations/OrganizationAgreements";

export const metadata: Metadata = { title: "Agreements" };

export default async function OrganizationAgreementsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return (
    <div className="app-page">
      <OrganizationAgreements organizationId={organizationId} />
    </div>
  );
}
