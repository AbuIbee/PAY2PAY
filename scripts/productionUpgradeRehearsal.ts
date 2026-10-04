/**
 * "PAID2YOU — FINAL TWO P0 CLOSURE ITEMS" (2026-10-03+), Item F: the seed/verify phases of the
 * representative pre-upgrade migration rehearsal. Orchestrated by
 * scripts/run-production-upgrade-rehearsal.mjs, which owns the disposable Postgres container and the
 * partial-then-full migration application — this file only ever talks to whatever DATABASE_URL points
 * it at, via the project's own real repositories/services, exactly like a `*.postgres.test.ts` file
 * would (never raw hand-rolled SQL for anything the schema already has a real insert path for).
 *
 * Run with: `npx tsx --conditions=react-server scripts/productionUpgradeRehearsal.ts --phase=seed --out=<file>`
 *       or: `npx tsx --conditions=react-server scripts/productionUpgradeRehearsal.ts --phase=verify --in=<file>`
 *
 * SEED phase runs against the database migrated ONLY THROUGH the chosen pre-upgrade cut point
 * (20261002030000_business_onboarding_fields.sql) — at that point `business_staff_member.role_id`/
 * `business_staff_invitation.role_id` are nullable with no CHECK constraint yet (added later by
 * 20261003040000_final_rbac_role_id_constraints.sql), so this is the one and only point in the whole
 * chain where a genuinely historical null-role_id row can be constructed via an ordinary insert — see
 * legacyRoleMigration.postgres.test.ts's own doc comment, which already documents this exact
 * structural fact and defers to this rehearsal for exercising it against real Postgres.
 *
 * VERIFY phase runs after the FULL remaining migration chain has been applied (plus the backfill) and
 * asserts every representative record survived with the same identity/values, every new constraint
 * genuinely holds, and the production commercial catalog is exactly correct.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  agreement,
  businessCustomer,
  businessObligation,
  businessProfile,
  businessStaffInvitation,
  businessStaffMember,
  legalAcceptance,
  organizationRole,
  personalProfile,
  platformBillingWebhookEvent,
  pricingPlan,
  pricingPlanEntitlement,
  subscription,
  subscriptionUsage,
  userAccount,
} from "@/db/schema";
import { AgreementService } from "@/lib/agreements/agreementService";
import { DrizzleAgreementPartyRepository } from "@/lib/agreements/drizzleAgreementPartyRepository";
import { DrizzleAgreementRepository } from "@/lib/agreements/drizzleAgreementRepository";
import { DrizzleAgreementVersionRepository } from "@/lib/agreements/drizzleAgreementVersionRepository";
import { DrizzleInstallmentScheduleItemRepository } from "@/lib/agreements/drizzleInstallmentScheduleItemRepository";
import { DrizzleRevisionApplicationRepository } from "@/lib/agreements/drizzleRevisionApplicationRepository";
import { DrizzleSigningApplicationRepository } from "@/lib/agreements/drizzleSigningApplicationRepository";
import { AuditService } from "@/lib/audit/auditService";
import { DrizzleAuditEventRepository } from "@/lib/audit/drizzleAuditEventRepository";
import { DrizzleProfileOwnerReader } from "@/lib/profiles/drizzleProfileOwnerReader";
import { DrizzleOrganizationRoleRepository } from "@/lib/organizations/drizzleOrganizationRoleRepository";
import { DrizzleBusinessCustomerRepository } from "@/lib/organizations/drizzleBusinessCustomerRepository";
import { DrizzleBusinessObligationRepository } from "@/lib/organizations/drizzleBusinessObligationRepository";
import { DrizzleLegalAcceptanceRepository } from "@/lib/legal/drizzleLegalAcceptanceRepository";
import { AgreementWorkspaceService } from "@/lib/organizations/agreementWorkspaceService";
import { OrganizationPermissionService } from "@/lib/organizations/organizationPermissionService";
import { EntitlementService } from "@/lib/organizations/entitlementService";
import { ORGANIZATION_AGREEMENTS_FEATURE_KEY } from "@/lib/organizations/entitlementFeatureKeys";
import { DrizzlePricingPlanEntitlementRepository } from "@/lib/pricing/drizzlePricingPlanEntitlementRepository";
import { DrizzlePricingPlanRepository } from "@/lib/pricing/drizzlePricingPlanRepository";
import { DrizzleSubscriptionRepository } from "@/lib/pricing/drizzleSubscriptionRepository";
import { PricingService } from "@/lib/pricing/pricingService";
import { DrizzleBusinessProfileRepository } from "@/lib/profiles/drizzleBusinessProfileRepository";
import { DrizzleBusinessStaffMemberRepository } from "@/lib/staff/drizzleBusinessStaffMemberRepository";

interface Sentinels {
  org1Id: string;
  org1OwnerUserId: string;
  org1OwnerMembershipId: string;
  org1FinanceAdminMembershipId: string;
  org1CustomRoleMembershipId: string;
  org1CustomRoleId: string;
  org1PendingInvitationId: string;
  org1PricingPlanId: string;
  org1SubscriptionId: string;
  org1CustomerId: string;
  org1ObligationId: string;
  org1AgreementId: string;
  org1LegalAcceptanceId: string;
  org1CustomerCounterpartyProfileId: string;
  org2Id: string;
  org2OwnerUserId: string;
  org2OwnerMembershipId: string;
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function log(message: string): void {
  console.log(`[upgrade-rehearsal:${process.env.REHEARSAL_PHASE ?? "?"}] ${message}`);
}

function fail(message: string): never {
  console.error(`[upgrade-rehearsal:${process.env.REHEARSAL_PHASE ?? "?"}] FAIL: ${message}`);
  process.exit(1);
}

async function seedPersonalUserRaw(emailPrefix: string): Promise<{ userId: string; profileId: string }> {
  const db = getDb();
  const [user] = await db
    .insert(userAccount)
    .values({ email: `${emailPrefix}-${randomUUID()}@upgrade-rehearsal.example`, authCredentialRef: `rehearsal-cred-${randomUUID()}` })
    .returning({ id: userAccount.id });
  if (!user) fail("user_account insert returned no row");
  const [profile] = await db.insert(personalProfile).values({ userId: user!.id }).returning({ id: personalProfile.id });
  if (!profile) fail("personal_profile insert returned no row");
  return { userId: user!.id, profileId: profile!.id };
}

async function seed(): Promise<void> {
  const db = getDb();
  log("seeding representative pre-upgrade data (business_staff_member.role_id is nullable here, no CHECK constraint yet)...");

  // --- Organization 1: the full representative record set ---
  const owner1 = await seedPersonalUserRaw("rehearsal-org1-owner");
  const [org1] = await db
    .insert(businessProfile)
    .values({
      ownerUserId: owner1.userId,
      legalBusinessName: `Rehearsal Trucking LLC ${randomUUID()}`,
      displayName: "Rehearsal Trucking",
      entityType: "LLC",
      businessAddress: { line1: "1 Rehearsal Way", city: "Dover", state: "DE", postalCode: "19901" },
      country: "US",
      state: "DE",
      // "PAID2YOU — SURGICAL FINAL P0 REMEDIATION" (2026-10-04), P0-5: EntitlementService now
      // requires onboarding_step = "billing_setup_complete" (provider-confirmed billing) before
      // granting any paid entitlement — org1 below exercises a fully-active, long-standing
      // organization (staff/subscription/customers/an agreement already exist for it), so it is
      // seeded already past that point, exactly as a real such organization would be.
      onboardingStep: "billing_setup_complete",
    })
    .returning({ id: businessProfile.id });
  if (!org1) fail("business_profile (org1) insert returned no row");

  // Owner membership — legacy role set, role_id deliberately NULL (historical pre-cutover row).
  const [ownerMembership] = await db
    .insert(businessStaffMember)
    .values({ businessProfileId: org1!.id, userId: owner1.userId, role: "OWNER", roleId: null, isAuthorizedRepresentative: true })
    .returning({ id: businessStaffMember.id });
  if (!ownerMembership) fail("business_staff_member (owner) insert returned no row");

  // Additional staff membership — also role_id NULL.
  const staff1 = await seedPersonalUserRaw("rehearsal-org1-finance-admin");
  const [financeAdminMembership] = await db
    .insert(businessStaffMember)
    .values({ businessProfileId: org1!.id, userId: staff1.userId, role: "FINANCE_ADMIN", roleId: null, isAuthorizedRepresentative: false })
    .returning({ id: businessStaffMember.id });
  if (!financeAdminMembership) fail("business_staff_member (finance admin) insert returned no row");

  // A membership whose role_id is ALREADY resolved to a hand-crafted custom role — proves the
  // backfill leaves an already-populated row alone (mirrors legacyRoleMigration.postgres.test.ts's
  // own "F" scenario, now against a genuinely historical row set).
  const roles = new DrizzleOrganizationRoleRepository();
  const customRole = await roles.insertRole({
    organizationId: org1!.id,
    displayName: "Rehearsal Hand-Crafted Role",
    description: "Pre-existing custom role at the pre-upgrade cut point.",
    isOwnerRole: false,
    isProtected: false,
    sortOrder: 99,
  });
  // Granted agreements.create so this membership — the only one in this seed set with a NON-null
  // role_id already resolved — can be the one to actually exercise the real
  // AgreementWorkspaceService.createDraftForWorkspace authorization path below. Owner1's own
  // membership is deliberately left role_id NULL (the historical row under test for the backfill), so
  // it cannot itself pass OrganizationPermissionService's authorization check yet — exactly the real
  // production invariant this rehearsal is proving.
  await roles.insertPermission({ roleId: customRole.id, permissionKey: "agreements.create", scope: "organization" });
  const staff2 = await seedPersonalUserRaw("rehearsal-org1-custom-role-member");
  const [customRoleMembership] = await db
    .insert(businessStaffMember)
    .values({ businessProfileId: org1!.id, userId: staff2.userId, role: "VIEWER", roleId: customRole.id, isAuthorizedRepresentative: false })
    .returning({ id: businessStaffMember.id });
  if (!customRoleMembership) fail("business_staff_member (custom role) insert returned no row");

  // A pending staff invitation — role_id deliberately NULL (historical pre-cutover row).
  const inviter = await seedPersonalUserRaw("rehearsal-org1-inviter");
  const [pendingInvitation] = await db
    .insert(businessStaffInvitation)
    .values({
      businessProfileId: org1!.id,
      email: `rehearsal-invitee-${randomUUID()}@upgrade-rehearsal.example`,
      role: "AR_MANAGER",
      roleId: null,
      invitedByUserId: inviter.userId,
      tokenHash: `rehearsal-token-hash-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: businessStaffInvitation.id });
  if (!pendingInvitation) fail("business_staff_invitation insert returned no row");

  // Pricing plan — pre-seeded BEFORE the production-commercial-catalog migration runs, exactly the
  // "a database already seeded by the test harness during development" scenario that migration's own
  // doc comment names as the reason its INSERTs are ON CONFLICT DO NOTHING.
  const [plan] = await db
    .insert(pricingPlan)
    .values({ kind: "business", code: "paid2you_business_core", name: "Core", monthlyFeeMinorUnits: 19900, isActive: true })
    .returning({ id: pricingPlan.id });
  if (!plan) fail("pricing_plan insert returned no row");

  const subscriptions = new DrizzleSubscriptionRepository();
  const sub = await subscriptions.insert({ profileKind: "business", profileId: org1!.id, pricingPlanId: plan!.id });

  const periodStart = new Date("2026-09-01T00:00:00Z");
  const periodEnd = new Date("2026-10-01T00:00:00Z");
  const [usage] = await db
    .insert(subscriptionUsage)
    .values({ organizationId: org1!.id, subscriptionId: sub.id, metricKey: "new_arrangements_monthly", periodStart, periodEnd, count: 3 })
    .returning({ id: subscriptionUsage.id });
  if (!usage) fail("subscription_usage insert returned no row");

  const customer1 = await seedPersonalUserRaw("rehearsal-org1-customer");
  const customers = new DrizzleBusinessCustomerRepository();
  const customerRecord = await customers.insert({
    businessProfileId: org1!.id,
    counterpartyProfileKind: "personal",
    counterpartyProfileId: customer1.profileId,
    externalCustomerReference: "SENTINEL-CUST-001",
  });

  const obligations = new DrizzleBusinessObligationRepository();
  const obligationRecord = await obligations.insert({
    businessProfileId: org1!.id,
    customerId: customerRecord.id,
    externalReference: "SENTINEL-OBL-001",
    invoiceReference: "SENTINEL-INV-001",
    originalAmountMinorUnits: 500_000,
    agreedAmountMinorUnits: 500_000,
  });

  const agreementService = new AgreementService({
    agreements: new DrizzleAgreementRepository(),
    versions: new DrizzleAgreementVersionRepository(),
    parties: new DrizzleAgreementPartyRepository(),
    scheduleItems: new DrizzleInstallmentScheduleItemRepository(),
    profileOwners: new DrizzleProfileOwnerReader(),
    staffService: {
      requireActiveStaff: () => {
        throw new Error("not implemented — org1's agreement always uses personal creditor/debtor parties, mirrors agreementWorkspaceTenancy.postgres.test.ts's own precedent");
      },
      requireCapability: () => {
        throw new Error("not implemented — see requireActiveStaff above");
      },
    } as unknown as import("@/lib/staff/staffService").StaffService,
    audit: new AuditService(new DrizzleAuditEventRepository()),
    signing: new DrizzleSigningApplicationRepository(),
    revisions: new DrizzleRevisionApplicationRepository(),
  });
  const permissions = new OrganizationPermissionService(new DrizzleBusinessProfileRepository(), new DrizzleBusinessStaffMemberRepository(), new DrizzleOrganizationRoleRepository());
  const entitlementService = new EntitlementService(
    new PricingService(new DrizzlePricingPlanRepository(), new DrizzleSubscriptionRepository()),
    new DrizzlePricingPlanEntitlementRepository(),
    new DrizzleBusinessProfileRepository(),
  );
  await db.insert(pricingPlanEntitlement).values({ pricingPlanId: plan!.id, featureKey: ORGANIZATION_AGREEMENTS_FEATURE_KEY, enabled: true, limitValue: null });
  const agreementWorkspaceService = new AgreementWorkspaceService(agreementService, permissions, entitlementService);

  const draftResult = await agreementWorkspaceService.createDraftForWorkspace({
    userId: staff2.userId,
    workspaceSelector: { kind: "organization", organizationId: org1!.id },
    draftInput: {
      creditor: { kind: "personal", id: staff2.profileId },
      debtor: { kind: "personal", id: customer1.profileId },
      category: "business_receivable",
      description: "Upgrade rehearsal sentinel agreement — SENTINEL-AGR-001",
      originalAmountMinorUnits: 500_000,
      previousPaymentsMinorUnits: 0,
      firstPaymentMinorUnits: 100_000,
      installmentAmountMinorUnits: 100_000,
      frequency: "monthly",
      firstPaymentDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      feeAllocation: "debtor_pays",
      earlyPayoffTerms: "No penalty.",
      hardshipRules: "Case by case.",
      partialPaymentRules: "Creditor approval required.",
      settlementRules: "Either party may propose.",
      disputeProcedure: "Contact support.",
    },
  });

  const legalAcceptances = new DrizzleLegalAcceptanceRepository();
  const legalAcceptanceRecord = await legalAcceptances.insert({
    userId: owner1.userId,
    organizationId: org1!.id,
    documentType: "terms",
    documentVersion: "2026-10-03",
    acceptedAt: new Date(),
    metadata: null,
  });

  // --- Organization 2: exists purely to prove cross-tenant non-contamination ---
  const owner2 = await seedPersonalUserRaw("rehearsal-org2-owner");
  const [org2] = await db
    .insert(businessProfile)
    .values({
      ownerUserId: owner2.userId,
      legalBusinessName: `Rehearsal Cross-Tenant Co ${randomUUID()}`,
      displayName: "Rehearsal Cross-Tenant Co",
      entityType: "LLC",
      businessAddress: {},
      country: "US",
      state: "TX",
    })
    .returning({ id: businessProfile.id });
  if (!org2) fail("business_profile (org2) insert returned no row");
  const [org2OwnerMembership] = await db
    .insert(businessStaffMember)
    .values({ businessProfileId: org2!.id, userId: owner2.userId, role: "OWNER", roleId: null, isAuthorizedRepresentative: true })
    .returning({ id: businessStaffMember.id });
  if (!org2OwnerMembership) fail("business_staff_member (org2 owner) insert returned no row");

  const sentinels: Sentinels = {
    org1Id: org1!.id,
    org1OwnerUserId: owner1.userId,
    org1OwnerMembershipId: ownerMembership!.id,
    org1FinanceAdminMembershipId: financeAdminMembership!.id,
    org1CustomRoleMembershipId: customRoleMembership!.id,
    org1CustomRoleId: customRole.id,
    org1PendingInvitationId: pendingInvitation!.id,
    org1PricingPlanId: plan!.id,
    org1SubscriptionId: sub.id,
    org1CustomerId: customerRecord.id,
    org1ObligationId: obligationRecord.id,
    org1AgreementId: draftResult.agreement.id,
    org1LegalAcceptanceId: legalAcceptanceRecord.id,
    org1CustomerCounterpartyProfileId: customer1.profileId,
    org2Id: org2!.id,
    org2OwnerUserId: owner2.userId,
    org2OwnerMembershipId: org2OwnerMembership!.id,
  };

  const outPath = arg("out");
  if (!outPath) fail("--out=<path> is required for the seed phase");
  writeFileSync(outPath!, JSON.stringify(sentinels, null, 2), "utf8");
  log(`seeded sentinel record set, written to ${outPath}`);
  log(`org1=${org1!.id} org2=${org2!.id} agreement=${draftResult.agreement.id} subscription=${sub.id}`);
}

function expect(condition: boolean, message: string): void {
  if (!condition) fail(message);
  log(`OK — ${message}`);
}

async function verify(): Promise<void> {
  const inPath = arg("in");
  if (!inPath) fail("--in=<path> is required for the verify phase");
  const s = JSON.parse(readFileSync(inPath!, "utf8")) as Sentinels;
  const db = getDb();

  log("verifying preservation + final-schema invariants after full forward migration...");

  // USER / PERSONAL PROFILE preservation
  const [user1] = await db.select().from(userAccount).where(eq(userAccount.id, s.org1OwnerUserId));
  expect(!!user1, "USER: org1 owner user_account row still exists");
  const [profile1] = await db.select().from(personalProfile).where(eq(personalProfile.userId, s.org1OwnerUserId));
  expect(!!profile1, "PERSONAL PROFILE: org1 owner personal_profile row still exists");

  // ORGANIZATION / OWNER preservation
  const [org1] = await db.select().from(businessProfile).where(eq(businessProfile.id, s.org1Id));
  expect(!!org1, "ORGANIZATION: org1 business_profile row still exists");
  expect(org1?.ownerUserId === s.org1OwnerUserId, "OWNER: org1.ownerUserId still points at the same user");

  // MEMBERSHIP preservation + role_id correctness
  const [ownerMembership] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, s.org1OwnerMembershipId));
  expect(!!ownerMembership, "MEMBERSHIP: org1 owner membership still exists");
  expect(ownerMembership?.roleId !== null, "ROLE_ID: org1 owner membership's role_id was backfilled to non-null");
  const [ownerRole] = await db.select().from(organizationRole).where(eq(organizationRole.id, ownerMembership!.roleId!));
  expect(ownerRole?.organizationId === s.org1Id, "ROLE: org1 owner's backfilled role belongs to the SAME organization (never cross-tenant)");
  expect(ownerRole?.isOwnerRole === true && ownerRole?.isProtected === true, "ROLE: org1 owner's backfilled role is the protected Owner role");

  const [financeAdminMembership] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, s.org1FinanceAdminMembershipId));
  expect(!!financeAdminMembership, "ADDITIONAL MEMBER: org1 finance-admin membership still exists");
  expect(financeAdminMembership?.roleId !== null, "ROLE_ID: org1 finance-admin membership's role_id was backfilled to non-null");
  expect(financeAdminMembership?.roleId !== ownerMembership!.roleId, "ROLE: finance-admin and owner were backfilled to DIFFERENT roles");

  // Already-resolved custom-role membership must be untouched by the backfill.
  const [customRoleMembership] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, s.org1CustomRoleMembershipId));
  expect(customRoleMembership?.roleId === s.org1CustomRoleId, "ROLE: the already-resolved custom-role membership was left untouched by the backfill (no duplicate/reassignment)");

  // Pending invitation preservation + role_id correctness
  const [invitation] = await db.select().from(businessStaffInvitation).where(eq(businessStaffInvitation.id, s.org1PendingInvitationId));
  expect(!!invitation, "INVITATION: org1 pending staff invitation still exists");
  expect(invitation?.roleId !== null, "ROLE_ID: org1 pending invitation's role_id was backfilled to non-null");
  const [invitationRole] = await db.select().from(organizationRole).where(eq(organizationRole.id, invitation!.roleId!));
  expect(invitationRole?.organizationId === s.org1Id, "ROLE: org1 invitation's backfilled role belongs to the SAME organization");

  // No duplicate roles created by the (double-run) backfill — exactly one role per legacy display name.
  const org1Roles = await db.select().from(organizationRole).where(eq(organizationRole.organizationId, s.org1Id));
  const ownerRoleCount = org1Roles.filter((r) => r.displayName === "Owner").length;
  const financeAdminRoleCount = org1Roles.filter((r) => r.displayName === "Finance Administrator").length;
  expect(ownerRoleCount === 1, `ROLE: exactly one 'Owner' role exists for org1 (found ${ownerRoleCount}) — the double backfill run did not duplicate it`);
  expect(financeAdminRoleCount === 1, `ROLE: exactly one 'Finance Administrator' role exists for org1 (found ${financeAdminRoleCount}) — the double backfill run did not duplicate it`);

  // CUSTOMER / BALANCE(OBLIGATION) preservation
  const [customer] = await db.select().from(businessCustomer).where(eq(businessCustomer.id, s.org1CustomerId));
  expect(customer?.externalCustomerReference === "SENTINEL-CUST-001", "CUSTOMER: org1's business_customer row preserved with its sentinel reference");
  expect(customer?.businessProfileId === s.org1Id, "TENANT OWNERSHIP: customer still points at org1");

  const [obligation] = await db.select().from(businessObligation).where(eq(businessObligation.id, s.org1ObligationId));
  expect(obligation?.externalReference === "SENTINEL-OBL-001", "BALANCE: org1's business_obligation row preserved with its sentinel reference");
  expect(obligation?.originalAmountMinorUnits === 500_000 && obligation?.agreedAmountMinorUnits === 500_000, "BALANCE: obligation amounts unchanged (500000/500000)");
  expect(obligation?.businessProfileId === s.org1Id, "TENANT OWNERSHIP: obligation still points at org1");

  // AGREEMENT preservation
  const [agreementRow] = await db.select().from(agreement).where(eq(agreement.id, s.org1AgreementId));
  expect(!!agreementRow, "AGREEMENT: org1's agreement row still exists");
  expect(agreementRow?.organizationId === s.org1Id, "TENANT OWNERSHIP: agreement.organization_id still equals org1 (not null, not org2)");

  // SUBSCRIPTION preservation + catalog linkage
  const [subscriptionRow] = await db.select().from(subscription).where(eq(subscription.id, s.org1SubscriptionId));
  expect(!!subscriptionRow, "SUBSCRIPTION: org1's subscription row still exists");
  expect(subscriptionRow?.pricingPlanId === s.org1PricingPlanId, "SUBSCRIPTION: still linked to the SAME (pre-seeded) pricing_plan row");
  expect(subscriptionRow?.profileId === s.org1Id, "TENANT OWNERSHIP: subscription still points at org1");

  // USAGE preservation
  const [usageRow] = await db
    .select()
    .from(subscriptionUsage)
    .where(and(eq(subscriptionUsage.subscriptionId, s.org1SubscriptionId), eq(subscriptionUsage.metricKey, "new_arrangements_monthly")));
  expect(usageRow?.count === 3, "USAGE: subscription_usage.count preserved (3)");

  // LEGAL ACCEPTANCE preservation
  const [legalRow] = await db.select().from(legalAcceptance).where(eq(legalAcceptance.id, s.org1LegalAcceptanceId));
  expect(legalRow?.documentVersion === "2026-10-03" && legalRow?.organizationId === s.org1Id, "LEGAL ACCEPTANCE: org1's acceptance row preserved with its organization and version");

  // CROSS-TENANT CONTAMINATION — org2 untouched, independent Owner role, no shared role id with org1.
  const [org2OwnerMembership] = await db.select().from(businessStaffMember).where(eq(businessStaffMember.id, s.org2OwnerMembershipId));
  expect(org2OwnerMembership?.roleId !== null, "ROLE_ID: org2 owner membership's role_id was backfilled to non-null");
  expect(org2OwnerMembership?.roleId !== ownerMembership!.roleId, "CROSS-TENANT CONTAMINATION: org1 and org2 Owner memberships resolved to DIFFERENT role rows");
  const [org2OwnerRole] = await db.select().from(organizationRole).where(eq(organizationRole.id, org2OwnerMembership!.roleId!));
  expect(org2OwnerRole?.organizationId === s.org2Id, "CROSS-TENANT CONTAMINATION: org2's backfilled role belongs to org2, not org1");

  // FINAL SCHEMA ASSERTIONS — commercial catalog
  const allPlans = await db.select().from(pricingPlan).where(eq(pricingPlan.kind, "business"));
  const byCode = new Map(allPlans.map((p) => [p.code, p]));
  expect(byCode.get("paid2you_business_starter")?.monthlyFeeMinorUnits === 9900, "CATALOG: Starter = $99");
  expect(byCode.get("paid2you_business_core")?.monthlyFeeMinorUnits === 19900, "CATALOG: Core = $199");
  expect(byCode.get("paid2you_business_growth")?.monthlyFeeMinorUnits === 69900, "CATALOG: Growth = $699");
  expect(byCode.get("paid2you_business_scale")?.monthlyFeeMinorUnits === 199900, "CATALOG: Scale = $1,999");
  expect(byCode.get("paid2you_business_enterprise")?.monthlyFeeMinorUnits === 500000, "CATALOG: Enterprise starting-reference = $5,000");
  const corePlans = allPlans.filter((p) => p.code === "paid2you_business_core");
  expect(corePlans.length === 1, `CATALOG: exactly one 'paid2you_business_core' row exists (found ${corePlans.length}) — the catalog migration's ON CONFLICT DO NOTHING did not duplicate the pre-seeded row`);
  expect(corePlans[0]?.id === s.org1PricingPlanId, "CATALOG: the surviving 'paid2you_business_core' row is the SAME pre-seeded row org1's subscription already points at");

  // CONSTRAINT PROOF — role_id-required CHECK constraints now genuinely reject a violating insert.
  const rejectUser = await seedPersonalUserRaw("rehearsal-constraint-check");
  let rejected = false;
  try {
    await db.insert(businessStaffMember).values({ businessProfileId: s.org1Id, userId: rejectUser.userId, role: "VIEWER", isAuthorizedRepresentative: false });
  } catch {
    rejected = true;
  }
  expect(rejected, "CONSTRAINT: the database itself now rejects an active membership insert with a null role_id");

  let invitationRejected = false;
  try {
    await db.insert(businessStaffInvitation).values({
      businessProfileId: s.org1Id,
      email: `rehearsal-constraint-${randomUUID()}@upgrade-rehearsal.example`,
      role: "VIEWER",
      invitedByUserId: s.org1OwnerUserId,
      tokenHash: `rehearsal-constraint-token-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
  } catch {
    invitationRejected = true;
  }
  expect(invitationRejected, "CONSTRAINT: the database itself now rejects a pending invitation insert with a null role_id");

  // PROVIDER EVENT UNIQUENESS — platform_billing_webhook_event(provider, provider_event_id) unique.
  const sharedEventId = `evt_rehearsal_${randomUUID()}`;
  await db.insert(platformBillingWebhookEvent).values({ provider: "stripe", providerEventId: sharedEventId, eventType: "invoice.paid", signatureVerified: true, payload: {} });
  let duplicateEventRejected = false;
  try {
    await db.insert(platformBillingWebhookEvent).values({ provider: "stripe", providerEventId: sharedEventId, eventType: "invoice.paid", signatureVerified: true, payload: {} });
  } catch {
    duplicateEventRejected = true;
  }
  expect(duplicateEventRejected, "CONSTRAINT: platform_billing_webhook_event(provider, provider_event_id) uniqueness genuinely holds");

  log("ALL VERIFY ASSERTIONS PASSED");
}

async function main(): Promise<void> {
  const phase = arg("phase");
  process.env.REHEARSAL_PHASE = phase;
  if (phase === "seed") {
    await seed();
  } else if (phase === "verify") {
    await verify();
  } else {
    fail(`unknown --phase="${phase}" — expected "seed" or "verify"`);
  }
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("[upgrade-rehearsal] fatal error:", error);
  process.exit(1);
});
