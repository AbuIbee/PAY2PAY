import type { Metadata } from "next";
import { Suspense } from "react";
import { BusinessOnboardingWizard } from "@/components/organizations/BusinessOnboardingWizard";

export const metadata: Metadata = { title: "Create Business Account" };

export default function NewOrganizationPage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <h1>Create Business Account</h1>
      </div>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <BusinessOnboardingWizard />
      </Suspense>
    </div>
  );
}
