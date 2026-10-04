import type { Metadata } from "next";
import { OrganizationBilling } from "@/components/organizations/OrganizationBilling";

export const metadata: Metadata = { title: "Billing & Subscription" };

export default async function OrganizationBillingPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return (
    <div className="app-page">
      <OrganizationBilling organizationId={organizationId} />
    </div>
  );
}
