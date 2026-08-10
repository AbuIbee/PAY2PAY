import { randomUUID } from "node:crypto";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { InMemorySessionRepository, InMemoryUserAccountRepository } from "@/lib/auth/testFakes";
import { createTestMfaService } from "@/lib/auth/mfaTestFakes";
import { AdminService } from "./adminService";
import type {
  AdminImpersonationSessionRecord,
  AdminImpersonationSessionRepository,
  AdminOverviewData,
  AdminOverviewReader,
  AdminUserDetail,
  AdminUserDirectoryReader,
  AdminUserSummary,
} from "./adminService";

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

  async getOverview(): Promise<AdminOverviewData> {
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

  const adminService = new AdminService({
    users,
    sessions,
    mfa: mfaService,
    audit,
    overview,
    directory,
    impersonationSessions,
  });

  return { adminService, users, sessions, mfaService, mfaCredentials, stepUps, directory, overview, impersonationSessions, auditRepo };
}
