import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { InMemorySessionRepository, InMemoryUserAccountRepository } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { InMemoryBusinessProfileRepository } from "@/lib/profiles/testFakes";
import { InMemoryBusinessStaffMemberRepository } from "@/lib/staff/testFakes";
import { AdminService } from "./adminService";
import type {
  AdminBusinessDetail,
  AdminBusinessDirectoryReader,
  AdminBusinessSummary,
  AdminImpersonationSessionRecord,
  AdminImpersonationSessionRepository,
  AdminOverviewData,
  AdminOverviewReader,
  AdminUserDetail,
  AdminUserDirectoryReader,
  AdminUserSummary,
} from "./adminService";
import type { AdminEnvironmentStatus, EnvironmentStatusReader } from "./environmentStatus";

/** Deterministic fake — never touches process.env, mirroring this file's other in-memory doubles. */
export class InMemoryEnvironmentStatusReader implements EnvironmentStatusReader {
  status: AdminEnvironmentStatus = {
    appEnv: "test",
    nodeEnv: "test",
    database: "configured",
    documentStorage: "not_configured",
    paymentProvider: "sandbox",
    kycProvider: "sandbox",
    emailDelivery: "console_log_only_no_provider",
    smsDelivery: "console_log_only_no_provider",
    scheduledJobs: "not_configured",
  };

  getStatus(): AdminEnvironmentStatus {
    return this.status;
  }
}

/** Test-only in-memory doubles for AdminService, mirroring src/lib/agreements/testFakes.ts's pattern. */

export class InMemoryAdminUserDirectoryReader implements AdminUserDirectoryReader {
  constructor(private readonly users: InMemoryUserAccountRepository) {}

  private toSummary(user: Awaited<ReturnType<InMemoryUserAccountRepository["findById"]>>): AdminUserSummary {
    const u = user!;
    return {
      id: u.id,
      email: u.email,
      status: u.status,
      platformRole: u.platformRole,
      accountClassification: u.accountClassification,
      createdAt: new Date(0), // not tracked by the auth fake; irrelevant to admin authorization tests
      lastLoginAt: null,
    };
  }

  async search(query: { email?: string; userId?: string }): Promise<AdminUserSummary[]> {
    if (query.userId) {
      const user = await this.users.findById(query.userId);
      return user ? [this.toSummary(user)] : [];
    }
    if (query.email) {
      const user = await this.users.findByEmail(query.email);
      return user ? [this.toSummary(user)] : [];
    }
    return [];
  }

  async getSummary(userId: string): Promise<AdminUserSummary | null> {
    const user = await this.users.findById(userId);
    return user ? this.toSummary(user) : null;
  }

  async getDetail(userId: string): Promise<AdminUserDetail | null> {
    const user = await this.users.findById(userId);
    if (!user) return null;
    return {
      ...this.toSummary(user),
      emailVerifiedAt: user.emailVerifiedAt,
      personalProfileId: null,
      businessProfiles: [],
      agreements: [],
    };
  }
}

export class InMemoryAdminOverviewReader implements AdminOverviewReader {
  constructor(private readonly users: InMemoryUserAccountRepository) {}

  async getOverview(): Promise<Omit<AdminOverviewData, "environmentStatus">> {
    const all = [...this.users.byId.values()];
    return {
      totalUsers: all.length,
      activeUsers: all.filter((u) => u.status === "active").length,
      suspendedUsers: all.filter((u) => u.status === "suspended").length,
      testAccounts: all.filter((u) => u.accountClassification !== "production").length,
      personalProfileCount: 0,
      businessProfileCount: 0,
      agreementCountsByStatus: {},
      signatureEventCount: 0,
      agreementPdfCount: 0,
      recentAuditEvents: [],
      recentAdminActions: [],
    };
  }
}

export class InMemoryAdminImpersonationSessionRepository implements AdminImpersonationSessionRepository {
  byId = new Map<string, AdminImpersonationSessionRecord>();

  async insert(input: { adminUserId: string; targetUserId: string; reason: string }): Promise<AdminImpersonationSessionRecord> {
    const record: AdminImpersonationSessionRecord = { id: randomUUID(), startedAt: new Date(), endedAt: null, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<AdminImpersonationSessionRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async markEnded(id: string, endedAt: Date): Promise<void> {
    const record = this.byId.get(id);
    if (record) record.endedAt = endedAt;
  }

  async findActiveForAdmin(adminUserId: string): Promise<AdminImpersonationSessionRecord | null> {
    for (const record of this.byId.values()) {
      if (record.adminUserId === adminUserId && !record.endedAt) return record;
    }
    return null;
  }
}

/** Mirrors InMemoryAdminUserDirectoryReader's own shape and simplifications (e.g. `agreements: []` — not tracked, irrelevant to admin authorization tests) for business_profile instead of user_account. */
export class InMemoryAdminBusinessDirectoryReader implements AdminBusinessDirectoryReader {
  constructor(
    private readonly businesses: InMemoryBusinessProfileRepository,
    private readonly users: InMemoryUserAccountRepository,
    private readonly staffMembers: {
      listActiveByBusiness(businessProfileId: string): Promise<{ userId: string; role: string; isAuthorizedRepresentative: boolean }[]>;
    },
  ) {}

  private async toSummary(businessId: string): Promise<AdminBusinessSummary | null> {
    const business = await this.businesses.findById(businessId);
    if (!business) return null;
    const owner = await this.users.findById(business.ownerUserId);
    if (!owner) return null;
    return {
      id: business.id,
      legalBusinessName: business.legalBusinessName,
      displayName: business.displayName,
      status: business.status,
      ownerUserId: owner.id,
      ownerEmail: owner.email,
      ownerPlatformRole: owner.platformRole,
      createdAt: business.createdAt,
    };
  }

  async search(query: { name?: string; businessId?: string }): Promise<AdminBusinessSummary[]> {
    if (query.businessId) {
      const summary = await this.toSummary(query.businessId);
      return summary ? [summary] : [];
    }
    if (query.name) {
      const needle = query.name.toLowerCase();
      const matches = [...this.businesses.byId.values()].filter(
        (b) => b.displayName.toLowerCase().includes(needle) || b.legalBusinessName.toLowerCase().includes(needle),
      );
      const summaries = await Promise.all(matches.map((b) => this.toSummary(b.id)));
      return summaries.filter((s): s is AdminBusinessSummary => s !== null);
    }
    return [];
  }

  async getSummary(businessId: string): Promise<AdminBusinessSummary | null> {
    return this.toSummary(businessId);
  }

  async getDetail(businessId: string): Promise<AdminBusinessDetail | null> {
    const summary = await this.toSummary(businessId);
    if (!summary) return null;
    const business = await this.businesses.findById(businessId);
    if (!business) return null;
    const members = await this.staffMembers.listActiveByBusiness(businessId);
    const membersWithEmail = await Promise.all(
      members.map(async (m) => {
        const user = await this.users.findById(m.userId);
        return { userId: m.userId, email: user?.email ?? "", role: m.role, isAuthorizedRepresentative: m.isAuthorizedRepresentative };
      }),
    );
    return {
      ...summary,
      entityType: business.entityType,
      country: business.country,
      state: business.state,
      members: membersWithEmail,
      agreements: [], // not tracked by this in-memory fake; irrelevant to admin authorization tests, mirrors InMemoryAdminUserDirectoryReader.getDetail
    };
  }
}

class InMemoryAuditEventRepositoryForAdmin implements AuditEventRepository {
  events: AuditEventRecord[] = [];
  private nextId = 1;

  async getLastEvent(): Promise<AuditEventRecord | null> {
    return this.events.at(-1) ?? null;
  }

  async insertEvent(record: Omit<AuditEventRecord, "id">): Promise<AuditEventRecord> {
    const stored: AuditEventRecord = { ...record, id: this.nextId++ };
    this.events.push(stored);
    return stored;
  }
}

export function createTestAdminService() {
  const users = new InMemoryUserAccountRepository();
  const sessions = new InMemorySessionRepository();
  const { mfaService, credentials: mfaCredentials, stepUps } = createTestMfaService();
  const directory = new InMemoryAdminUserDirectoryReader(users);
  const overview = new InMemoryAdminOverviewReader(users);
  const impersonationSessions = new InMemoryAdminImpersonationSessionRepository();
  const auditRepo = new InMemoryAuditEventRepositoryForAdmin();
  const audit = new AuditService(auditRepo);
  const environmentStatus = new InMemoryEnvironmentStatusReader();
  const businesses = new InMemoryBusinessProfileRepository();
  const staffMembers = new InMemoryBusinessStaffMemberRepository();
  const businessDirectory = new InMemoryAdminBusinessDirectoryReader(businesses, users, staffMembers);

  const adminService = new AdminService({
    users,
    sessions,
    mfa: mfaService,
    audit,
    overview,
    directory,
    impersonationSessions,
    environmentStatus,
    businesses,
    businessDirectory,
  });

  return {
    adminService,
    users,
    sessions,
    mfaService,
    mfaCredentials,
    stepUps,
    directory,
    overview,
    impersonationSessions,
    auditRepo,
    environmentStatus,
    businesses,
    staffMembers,
    businessDirectory,
  };
}
