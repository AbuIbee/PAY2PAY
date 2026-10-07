import type { Metadata } from "next";
import { Suspense } from "react";
import { BusinessOnboardingWizard } from "@/components/organizations/BusinessOnboardingWizard";
export const metadata: Metadata = { title: "Create Business Account" };
export default function NewOrganizationPage(){return <div className="app-page business-onboarding-page"><div className="app-page__header business-onboarding-page__header"><div><span className="business-onboarding-page__eyebrow">PAID2YOU BUSINESS</span><h1>Create <span>Business Account</span></h1><p className="app-page__lede">Set up your Business account while keeping the Personal and Business experiences distinct. Your organization details, employees, customers, agreements, and subscription settings remain business-scoped.</p></div></div><Suspense fallback={<p role="status">Loading…</p>}><BusinessOnboardingWizard /></Suspense></div>}
