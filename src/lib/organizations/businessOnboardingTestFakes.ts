import "server-only";
import { AuditService } from "@/lib/audit/auditService";
import { createTestLegalAcceptanceService } from "@/lib/legal/legalAcceptanceTestFakes";
import { seedCanonicalBusinessPlans } from "@/lib/pricing/seedCanonicalBusinessPlans";
import { InMemoryPricingPlanEntitlementRepository, InMemoryPricingPlanRepository, InMemorySubscriptionRepository } from "@/lib/pricing/testFakes";
import { PricingService } from "@/lib/pricing/pricingService";
import { BusinessProfileService } from "@/lib/profiles/businessProfileService";
import { InMemoryAtomicBusinessProfileCreator, InMemoryAuditEventRepositoryForProfiles, InMemoryBusinessProfileRepository } from "@/lib/profiles/testFakes";
import { InMemoryBusinessStaffMemberRepository } from "@/lib/staff/testFakes";
import { SandboxBusinessVerificationProvider } from "@/test-support/organizations/sandboxBusinessVerificationProvider";
import { SandboxPlatformBillingProvider } from "@/test-support/organizations/sandboxPlatformBillingProvider";
import { BusinessActivationService } from "./businessActivationService";
import { BusinessOnboardingService } from "./businessOnboardingService";
import { BusinessVerificationService } from "./businessVerificationService";
import { InMemoryBusinessVerificationRepository } from "./businessVerificationTestFakes";
import { OrganizationRoleService } from "./organizationRoleService";
import { InMemoryOrganizationRoleRepository } from "./organizationRoleTestFakes";
import { PlatformBillingService } from "./platformBillingService";
import { InMemorySubscriptionInvoiceRepository, InMemorySubscriptionPaymentMethodRepository } from "./platformBillingTestFakes";

/**
 * "PAID2YOU PLATFORM EXPANSION" (2026-10-02): the one assembly point for BusinessOnboardingService's
 * full dependency graph in tests — every dependency is an existing, already-tested in-memory fake
 * from its own domain's testFakes module; nothing new is invented here.
 */
export async function createBusinessOnboardingTestHarness() {
  const businessProfiles = new InMemoryBusinessProfileRepository();
  const staffMembers = new InMemoryBusinessStaffMemberRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForProfiles();
  const audit = new AuditService(auditRepo);
  const profileCreator = new InMemoryAtomicBusinessProfileCreator(businessProfiles, staffMembers);
  const businessProfileService = new BusinessProfileService(businessProfiles, audit, profileCreator);

  const organizationRoles = new InMemoryOrganizationRoleRepository();
  const organizationRoleService = new OrganizationRoleService(organizationRoles);

  const verificationProvider = new SandboxBusinessVerificationProvider("test-secret");
  const verifications = new InMemoryBusinessVerificationRepository();
  const verificationService = new BusinessVerificationService(verificationProvider, verifications, audit);

  const plans = new InMemoryPricingPlanRepository();
  const entitlements = new InMemoryPricingPlanEntitlementRepository();
  const subscriptions = new InMemorySubscriptionRepository();
  await seedCanonicalBusinessPlans(plans, entitlements);
  const pricing = new PricingService(plans, subscriptions);

  const billingProvider = new SandboxPlatformBillingProvider("test-secret");
  const invoices = new InMemorySubscriptionInvoiceRepository();
  const paymentMethods = new InMemorySubscriptionPaymentMethodRepository();
  const billing = new PlatformBillingService(billingProvider, subscriptions, plans, invoices, paymentMethods, audit);

  const { legalAcceptanceService, repo: legalAcceptanceRepo } = createTestLegalAcceptanceService();
  const activation = new BusinessActivationService(businessProfiles, verifications, subscriptions, legalAcceptanceService);

  const onboarding = new BusinessOnboardingService(
    businessProfiles,
    businessProfileService,
    staffMembers,
    organizationRoleService,
    () => verificationService,
    verifications,
    pricing,
    subscriptions,
    () => billing,
    activation,
    legalAcceptanceService,
  );

  return {
    onboarding,
    activation,
    businessProfiles,
    staffMembers,
    organizationRoles,
    verifications,
    verificationProvider,
    verificationService,
    audit,
    auditRepo,
    plans,
    subscriptions,
    invoices,
    paymentMethods,
    billingProvider,
    legalAcceptanceService,
    legalAcceptanceRepo,
  };
}
