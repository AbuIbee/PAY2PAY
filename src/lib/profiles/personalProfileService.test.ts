import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditService, type AuditEventRecord, type AuditEventRepository } from "@/lib/audit/auditService";
import { hashOpaqueToken } from "@/lib/auth/token";
import { ValidationError } from "@/lib/errors";
import { InMemoryEmailSender } from "@/lib/notify/testFakes";
import {
  PersonalProfileService,
  type PersonalAddress,
  type PersonalProfileRecord,
  type PersonalProfileRepository,
  type PreferredEmailVerificationRepository,
  type UserAuthEmailReader,
} from "./personalProfileService";

class InMemoryPersonalProfileRepositoryForThisTest implements PersonalProfileRepository {
  byId = new Map<string, PersonalProfileRecord>();

  seed(userId: string, overrides: Partial<PersonalProfileRecord> = {}): PersonalProfileRecord {
    const now = new Date();
    const record: PersonalProfileRecord = {
      id: randomUUID(),
      userId,
      legalName: null,
      firstName: null,
      lastName: null,
      preferredEmail: null,
      preferredEmailVerifiedAt: null,
      contactPhone: null,
      residentialAddress: null,
      currency: "USD",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async findByUserId(userId: string): Promise<PersonalProfileRecord | null> {
    return [...this.byId.values()].find((r) => r.userId === userId) ?? null;
  }

  async findById(id: string): Promise<PersonalProfileRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async update(
    id: string,
    input: {
      firstName: string;
      lastName: string;
      preferredEmail: string;
      preferredEmailVerifiedAt: Date | null;
      contactPhone: string;
      residentialAddress: PersonalAddress;
    },
  ): Promise<PersonalProfileRecord> {
    const record = this.byId.get(id);
    if (!record) throw new Error("profile not found");
    Object.assign(record, input, { updatedAt: new Date() });
    return record;
  }
}

class InMemoryPreferredEmailVerificationRepository implements PreferredEmailVerificationRepository {
  rows: { id: string; personalProfileId: string; email: string; tokenHash: string; expiresAt: Date; consumedAt: Date | null }[] = [];

  async insert(input: { personalProfileId: string; email: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }> {
    const row = { id: randomUUID(), consumedAt: null, ...input };
    this.rows.push(row);
    return { id: row.id };
  }

  async findByTokenHash(tokenHash: string) {
    return this.rows.find((r) => r.tokenHash === tokenHash) ?? null;
  }

  async consume(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.consumedAt = new Date();
  }
}

class InMemoryUserAuthEmailReader implements UserAuthEmailReader {
  private byUserId = new Map<string, string | null>();

  set(userId: string, email: string | null): void {
    this.byUserId.set(userId, email);
  }

  async getVerifiedEmail(userId: string): Promise<string | null> {
    return this.byUserId.get(userId) ?? null;
  }
}

class InMemoryAuditEventRepositoryForThisTest implements AuditEventRepository {
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

const ADDRESS: PersonalAddress = { line1: "1 Main St", line2: null, city: "Austin", state: "TX", postalCode: "78701", country: "US" };

function createCtx() {
  const profiles = new InMemoryPersonalProfileRepositoryForThisTest();
  const verificationTokens = new InMemoryPreferredEmailVerificationRepository();
  const authEmails = new InMemoryUserAuthEmailReader();
  const emailSender = new InMemoryEmailSender();
  const audit = new AuditService(new InMemoryAuditEventRepositoryForThisTest());
  const service = new PersonalProfileService({
    profiles,
    verificationTokens,
    authEmails,
    emailSender,
    audit,
    appUrl: "https://paid2you.test",
  });
  return { profiles, verificationTokens, authEmails, emailSender, audit, service };
}

describe("PersonalProfileService", () => {
  let ctx: ReturnType<typeof createCtx>;
  let userId: string;

  beforeEach(() => {
    ctx = createCtx();
    userId = randomUUID();
  });

  describe("Decision 6: preferred email verification rules", () => {
    it("test 21: preferredEmail equal to the already-verified auth email is treated as verified without a duplicate verification email", async () => {
      ctx.profiles.seed(userId);
      ctx.authEmails.set(userId, "person@example.com");

      const updated = await ctx.service.updateMyProfile(userId, {
        firstName: "Ada",
        lastName: "Lovelace",
        preferredEmail: "person@example.com",
        contactPhone: "555-0100",
        address: ADDRESS,
      });

      expect(updated.preferredEmailVerifiedAt).not.toBeNull();
      expect(ctx.emailSender.sent).toHaveLength(0);
    });

    it("test 22: changing preferredEmail to a different address never changes the auth/login email", async () => {
      const profile = ctx.profiles.seed(userId);
      ctx.authEmails.set(userId, "person@example.com");

      await ctx.service.updateMyProfile(userId, {
        firstName: "Ada",
        lastName: "Lovelace",
        preferredEmail: "alt-address@example.com",
        contactPhone: "555-0100",
        address: ADDRESS,
      });

      // The service has no write path to user_account.email at all — the auth reader's own state
      // (the thing that would change if it did) is untouched.
      expect(await ctx.authEmails.getVerifiedEmail(userId)).toBe("person@example.com");
      const stored = await ctx.profiles.findById(profile.id);
      expect(stored?.preferredEmail).toBe("alt-address@example.com");
    });

    it("test 23a: a newly-set alternate preferred email starts unverified, and a verification email is sent", async () => {
      ctx.profiles.seed(userId);
      ctx.authEmails.set(userId, "person@example.com");

      const updated = await ctx.service.updateMyProfile(userId, {
        firstName: "Ada",
        lastName: "Lovelace",
        preferredEmail: "alt-address@example.com",
        contactPhone: "555-0100",
        address: ADDRESS,
      });

      expect(updated.preferredEmailVerifiedAt).toBeNull();
      expect(ctx.emailSender.sent).toHaveLength(1);
      expect(ctx.emailSender.sent[0]!.to).toBe("alt-address@example.com");
      expect(ctx.verificationTokens.rows).toHaveLength(1);
    });

    it("test 23b: an unverified alternate preferred email cannot be represented as verified until the token is confirmed, and confirming it marks it verified", async () => {
      ctx.profiles.seed(userId);
      ctx.authEmails.set(userId, "person@example.com");
      await ctx.service.updateMyProfile(userId, {
        firstName: "Ada",
        lastName: "Lovelace",
        preferredEmail: "alt-address@example.com",
        contactPhone: "555-0100",
        address: ADDRESS,
      });

      const before = await ctx.service.getMyProfile(userId);
      expect(before.preferredEmailVerifiedAt).toBeNull();

      // Recover the raw token the way the real verification email link would carry it: the service
      // only stores the hash, so re-derive from the CTA link the fake email sender captured.
      const link = ctx.emailSender.sent[0]!.ctaUrl!;
      const rawToken = new URL(link).searchParams.get("token")!;
      await ctx.service.confirmPreferredEmail(rawToken);

      const after = await ctx.service.getMyProfile(userId);
      expect(after.preferredEmailVerifiedAt).not.toBeNull();
      expect(after.preferredEmail).toBe("alt-address@example.com");
    });

    it("test 23c: a stale verification link for an address the user has since changed away from does not resurrect it as verified", async () => {
      ctx.profiles.seed(userId);
      ctx.authEmails.set(userId, "person@example.com");
      await ctx.service.updateMyProfile(userId, {
        firstName: "Ada",
        lastName: "Lovelace",
        preferredEmail: "alt-address@example.com",
        contactPhone: "555-0100",
        address: ADDRESS,
      });
      const staleLink = ctx.emailSender.sent[0]!.ctaUrl!;
      const staleToken = new URL(staleLink).searchParams.get("token")!;

      // The user changes their mind again before confirming.
      await ctx.service.updateMyProfile(userId, {
        firstName: "Ada",
        lastName: "Lovelace",
        preferredEmail: "yet-another@example.com",
        contactPhone: "555-0100",
        address: ADDRESS,
      });

      await ctx.service.confirmPreferredEmail(staleToken);

      const after = await ctx.service.getMyProfile(userId);
      expect(after.preferredEmail).toBe("yet-another@example.com");
      expect(after.preferredEmailVerifiedAt).toBeNull();
    });

    it("an expired verification token is rejected", async () => {
      const profile = ctx.profiles.seed(userId, { preferredEmail: "alt@example.com" });
      const rawToken = "expired-raw-token";
      await ctx.verificationTokens.insert({
        personalProfileId: profile.id,
        email: "alt@example.com",
        tokenHash: hashOpaqueToken(rawToken),
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(ctx.service.confirmPreferredEmail(rawToken)).rejects.toThrow(ValidationError);
    });

    it("an unrecognized token is rejected", async () => {
      await expect(ctx.service.confirmPreferredEmail("not-a-real-token")).rejects.toThrow(ValidationError);
    });
  });

  describe("agreement participation readiness gate (corrected — requires the FULL profile, address line 2 excepted)", () => {
    const COMPLETE_PROFILE = {
      firstName: "Ada",
      lastName: "Lovelace",
      preferredEmail: "ada@example.com",
      preferredEmailVerifiedAt: new Date(),
      contactPhone: "555-0100",
      residentialAddress: ADDRESS,
    };

    it("is ready once every required field (contact phone and full address included) is present", async () => {
      ctx.profiles.seed(userId, COMPLETE_PROFILE);
      const result = await ctx.service.checkAgreementParticipationReadiness(userId);
      expect(result).toEqual({ ready: true, missingFields: [] });
    });

    it("address line 2 is optional — omitting it never blocks readiness", async () => {
      ctx.profiles.seed(userId, { ...COMPLETE_PROFILE, residentialAddress: { ...ADDRESS, line2: null } });
      const result = await ctx.service.checkAgreementParticipationReadiness(userId);
      expect(result).toEqual({ ready: true, missingFields: [] });
    });

    it.each([
      ["firstName", { firstName: null }, "firstName"],
      ["lastName", { lastName: null }, "lastName"],
      ["contactPhone", { contactPhone: null }, "contactPhone"],
      ["preferredEmail unset", { preferredEmail: null, preferredEmailVerifiedAt: null }, "preferredEmail"],
      ["preferredEmail set but unverified", { preferredEmailVerifiedAt: null }, "preferredEmail"],
    ] as const)("missing/invalid %s independently causes ready=false with missingFields=[%s]", async (_label, override, expectedField) => {
      ctx.profiles.seed(userId, { ...COMPLETE_PROFILE, ...override });
      const result = await ctx.service.checkAgreementParticipationReadiness(userId);
      expect(result.ready).toBe(false);
      expect(result.missingFields).toEqual([expectedField]);
    });

    it.each([
      ["line1", "line1"],
      ["city", "city"],
      ["state", "state"],
      ["postalCode", "postalCode"],
      ["country", "country"],
    ] as const)("missing address.%s independently causes ready=false with missingFields=[%s]", async (addressField, expectedField) => {
      ctx.profiles.seed(userId, { ...COMPLETE_PROFILE, residentialAddress: { ...ADDRESS, [addressField]: "" } });
      const result = await ctx.service.checkAgreementParticipationReadiness(userId);
      expect(result.ready).toBe(false);
      expect(result.missingFields).toEqual([expectedField]);
    });

    it("checkProfileCompleteness reports the identical required-field set (the two gates can never drift apart)", async () => {
      ctx.profiles.seed(userId, { ...COMPLETE_PROFILE, contactPhone: null });
      const readiness = await ctx.service.checkAgreementParticipationReadiness(userId);
      const completeness = await ctx.service.checkProfileCompleteness(userId);
      expect(readiness.missingFields).toEqual(completeness.missingFields);
      expect(readiness.ready).toBe(completeness.complete);
    });

    it("reports every missing field at once when the profile is entirely blank", async () => {
      ctx.profiles.seed(userId);
      const result = await ctx.service.checkAgreementParticipationReadiness(userId);
      expect(result.ready).toBe(false);
      expect(result.missingFields).toEqual(["firstName", "lastName", "preferredEmail", "contactPhone", "line1", "city", "state", "postalCode", "country"]);
    });
  });

  it("own-profile isolation: requireOwnProfile rejects a profile id belonging to a different user", async () => {
    const mine = ctx.profiles.seed(userId);
    const strangerId = randomUUID();
    const theirs = ctx.profiles.seed(strangerId);

    await expect(ctx.service.requireOwnProfile(userId, mine.id)).resolves.toMatchObject({ id: mine.id });
    await expect(ctx.service.requireOwnProfile(userId, theirs.id)).rejects.toThrow();
  });
});
