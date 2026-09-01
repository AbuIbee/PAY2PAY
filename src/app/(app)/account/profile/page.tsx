import type { Metadata } from "next";
import { Suspense } from "react";
import { PersonalProfileForm } from "@/components/PersonalProfileForm";

export const metadata: Metadata = { title: "Personal information" };

export default function AccountProfilePage() {
  return (
    <div className="app-page">
      <div className="app-page__header">
        <div>
          <h1>Personal information</h1>
          <p className="app-page__lede">
            This information is shown on your agreements and used for agreement-related contact. It never changes your sign-in email.
          </p>
        </div>
      </div>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <PersonalProfileForm />
      </Suspense>
    </div>
  );
}
