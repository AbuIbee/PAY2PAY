import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { generateOpaqueToken, hashOpaqueToken } from "@/lib/auth/token";
import type { PartyRole } from "@/lib/agreements/agreementService";
import type { Capability } from "@/lib/staff/capabilities";
import type { StaffService } from "@/lib/staff/staffService";
import type { EmailSender } from "@/lib/notify/emailSender";
import type { NotificationService } from "@/lib/notify/notificationService";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { RelationshipRecord, RelationshipRepository, RelationshipParticipantRepository } from "./relationshipService";

export type RelationshipInvitationStatus = "sent" | "viewed" | "accepted" | "declined" | "expired" | "cancelled";

export interface RelationshipInvitationRecord {
  id: string;
  relationshipId: string;
  inviterUserId: string;
  inviteeEmail: string;
  inviteeRole: PartyRole;
  status: RelationshipInvitationStatus;
  tokenHash: string;
  resolvedInviteeUserId: string | null;
  createdAt: Date;
  expiresAt: Date;
  viewedAt: Date | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  cancelledAt: Date | null;
  updatedAt: Date;
}

export interface PartyRef {
  kind: ProfileKind;
  id: string;
}

/** Real implementation: DrizzleRelationshipInvitationRepository. */
export interface RelationshipInvitationRepository {
  insert(input: {
    relationshipId: string;
    inviterUserId: string;
    inviteeEmail: string;
    inviteeRole: PartyRole;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RelationshipInvitationRecord>;
  findById(id: string): Promise<RelationshipInvitationRecord | null>;
  findByTokenHash(tokenHash: string): Promise<RelationshipInvitationRecord | null>;
  findByRelationshipId(relationshipId: string): Promise<RelationshipInvitationRecord[]>;
  setResolvedInviteeUser(id: string, userId: string): Promise<RelationshipInvitationRecord>;
  markViewed(id: string): Promise<RelationshipInvitationRecord>;
  /**
   * PRSprint 31 (docs/prsprints/PRSPRINT_31_E2E_NEGATIVE_SECURITY_CONCURRENCY_TEST_COMPLETION.md):
   * these three are mutually-exclusive terminal decisions on the same invitation (accept vs. decline
   * vs. the inviter cancelling) — a genuine concurrency bug existed here: the prior single-argument
   * signature updated the row unconditionally (`WHERE id = $1`, no status guard), so two of these
   * racing (e.g. "recipient accepts" concurrently with "inviter cancels") could both appear to
   * succeed, silently overwriting each other with no error to either caller. Now atomic — succeeds
   * only if the row is still in one of `fromStatuses` at write time (mirrors a real
   * `UPDATE ... WHERE status IN (...)`), returning `null` if another decision already won the race,
   * which the caller must treat as "no longer open," not retry-and-overwrite.
   */
  markAccepted(id: string): Promise<RelationshipInvitationRecord | null>;
  markDeclined(id: string): Promise<RelationshipInvitationRecord | null>;
  markCancelled(id: string): Promise<RelationshipInvitationRecord | null>;
  /** Cron-scan entry point, mirroring PaymentRetryRepository.findDueForFiring's precedent. */
  findDueForExpiry(now: Date): Promise<RelationshipInvitationRecord[]>;
  markExpired(id: string): Promise<RelationshipInvitationRecord>;
}

/** Narrow, consumer-defined view for resolving an existing user by email — mirrors this codebase's interface-segregation precedent (e.g. AgreementTermsReader). Real implementation queries user_account directly, same style as DrizzleUserContactReader. */
export interface UserLookupReader {
  findUserIdByEmail(email: string): Promise<string | null>;
}

const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RelationshipInvitationServiceDeps {
  relationships: RelationshipRepository;
  participants: RelationshipParticipantRepository;
  invitations: RelationshipInvitationRepository;
  profileOwners: ProfileOwnerReader;
  staffService: StaffService;
  users: UserLookupReader;
  notifications: NotificationService;
  emailSender: EmailSender;
  audit: AuditService;
  /** PRSprint 14 (docs/prsprints/PRSPRINT_14_PRODUCTION_EMAIL.md): base URL for the enrollment link sent to a not-yet-registered invitee — mirrors AgreementInvitationService's own identical `appUrl` dependency. */
  appUrl: string;
}

/**
 * Sprint 18A (docs/sprints/Sprint_18A_CooperativeAccountPairing_FinancialAccountLinking_
 * RelationshipArchitecture.md) §5–§9's cooperative account handshake. A relationship may not become
 * active "because one party simply enters another person's email address" — this class is the entire
 * enforcement of that: `createInvitation` only ever creates a `relationship` in status `invited` plus
 * the inviter's own participant row; the invitee's participant row, and every further lifecycle
 * transition, is created only by `acceptInvitation`, which requires either (a) the invitation having
 * already been resolved to this exact `actingUserId` (an existing platform user, matched by email at
 * creation time) or (b) presenting the raw invitation token (proves receipt of the one email this
 * secret was ever sent to). "A logged-in User B must not be able to accept an invitation intended for
 * User C" is enforced by requiring one of those two proofs on every acceptance, never merely trusting
 * the caller's own `actingUserId`.
 *
 * Party authorization mirrors `AgreementService`'s own private `authorizeParty` exactly (personal:
 * owner-only; business: owner bypasses, otherwise active staff member with the capability) —
 * duplicated here rather than reused because this class operates *before* any agreement exists, so
 * there is no `AgreementService` instance to delegate to. `send_invitation` (Sprint 4's own fixed
 * 13-capability list) gates both creating an invitation on a business's behalf and accepting one —
 * there is no dedicated "invite/accept relationship" capability in that fixed list, and reusing the
 * closest existing one avoids inventing a competing capability system.
 *
 * The raw invitation token is never persisted anywhere (only `hashOpaqueToken`'s digest is) and is
 * never routed through `NotificationService.notify()` — that method's payload is durably persisted to
 * `notification_event.payload`, which would put the secret at rest outside this table entirely. For
 * an *existing* platform user, the invitation notification is deliberately token-free ("you have a
 * pending relationship invitation — log in to view it") and reuses `NotificationService.notify()`
 * exactly like every other event type. For a *not-yet-registered* email, `NotificationService.notify()`
 * cannot be used at all — its own signature requires a known `recipientUserId`, which a pre-signup
 * invitee has none of — so this one enrollment email is sent directly through the same underlying
 * `EmailSender` primitive `NotificationService` itself uses internally, carrying the raw token this
 * one time, at send time only. This is not a second notification system; it is the one case Sprint
 * 17's own `notify()` contract cannot represent.
 */
export class RelationshipInvitationService {
  constructor(private readonly deps: RelationshipInvitationServiceDeps) {}

  async createInvitation(input: {
    actingUserId: string;
    actingParty: PartyRef;
    inviteeEmail: string;
    inviteeRole: PartyRole;
  }): Promise<{ relationship: RelationshipRecord; invitation: RelationshipInvitationRecord; rawToken: string }> {
    await this.authorizeParty(input.actingUserId, input.actingParty, "send_invitation");
    if (!input.inviteeEmail.trim() || !input.inviteeEmail.includes("@")) {
      throw new ValidationError("A valid invitee email is required.");
    }

    const relationship = await this.deps.relationships.insert({ initiatorUserId: input.actingUserId });
    const inviterRole: PartyRole = input.inviteeRole === "creditor" ? "debtor" : "creditor";
    await this.deps.participants.insert({
      relationshipId: relationship.id,
      individualProfileId: input.actingParty.kind === "personal" ? input.actingParty.id : null,
      organizationId: input.actingParty.kind === "business" ? input.actingParty.id : null,
      role: inviterRole,
      status: "active",
      representedByUserId: input.actingUserId,
      joinedAt: new Date(),
    });

    const rawToken = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(rawToken);
    const expiresAt = new Date(Date.now() + DEFAULT_INVITATION_TTL_MS);
    const invitation = await this.deps.invitations.insert({
      relationshipId: relationship.id,
      inviterUserId: input.actingUserId,
      inviteeEmail: input.inviteeEmail,
      inviteeRole: input.inviteeRole,
      tokenHash,
      expiresAt,
    });

    await this.recordAudit(relationship.id, input.actingUserId, "RELATIONSHIP_CREATED", { context: "invitation" });
    await this.recordAudit(relationship.id, input.actingUserId, "RELATIONSHIP_PARTICIPANT_LINKED", { role: inviterRole });
    await this.recordAudit(relationship.id, input.actingUserId, "RELATIONSHIP_INVITATION_CREATED", { invitationId: invitation.id });

    const existingUserId = await this.deps.users.findUserIdByEmail(input.inviteeEmail);
    if (existingUserId) {
      const resolved = await this.deps.invitations.setResolvedInviteeUser(invitation.id, existingUserId);
      await this.deps.notifications.notify({
        recipientUserId: existingUserId,
        notificationType: "relationship_invitation",
        relatedAgreementId: null,
        payload: { relationshipId: relationship.id, invitationId: invitation.id },
        dedupeKey: `relationship_invitation:${invitation.id}:${existingUserId}`,
      });
      await this.recordAudit(relationship.id, input.actingUserId, "RELATIONSHIP_INVITATION_SENT", { channel: "in_app_and_email", invitationId: invitation.id });
      return { relationship, invitation: resolved, rawToken };
    }

    // New-user path — see this class's own doc comment for why this bypasses NotificationService.
    // PRSprint 14: this previously embedded the bare raw token (`token=${rawToken}`) instead of a
    // real link — fixed to match AgreementInvitationService/StaffService's own established
    // `${appUrl}/...?token=...` pattern, since the token alone is not something a recipient can act
    // on from an email client.
    const link = `${this.deps.appUrl}/connections/accept?token=${rawToken}`;
    await this.deps.emailSender.send({
      to: input.inviteeEmail,
      subject: "You've been invited to a repayment relationship on PAY2PAY",
      body: `You've been invited to a repayment relationship on PAY2PAY. Create an account to review and respond: ${link}\n\nThis link expires in 7 days.`,
      ctaUrl: link,
      ctaText: "Review the invitation",
    });
    await this.recordAudit(relationship.id, input.actingUserId, "RELATIONSHIP_INVITATION_SENT", { channel: "email_enrollment", invitationId: invitation.id });
    return { relationship, invitation, rawToken };
  }

  /** Read-only, unauthenticated-safe lookup for the enrollment/deep-link flow — never mutates state, never reveals more than the minimum needed to recognize the invitation exists and is still open. */
  async resolveInvitationByToken(rawToken: string): Promise<{ invitationId: string; relationshipId: string; inviteeEmail: string; inviteeRole: PartyRole } | null> {
    const tokenHash = hashOpaqueToken(rawToken);
    const invitation = await this.findByTokenHashUnsafe(tokenHash);
    if (!invitation) return null;
    if (invitation.status !== "sent" && invitation.status !== "viewed") return null;
    if (invitation.expiresAt.getTime() <= Date.now()) return null;
    return { invitationId: invitation.id, relationshipId: invitation.relationshipId, inviteeEmail: invitation.inviteeEmail, inviteeRole: invitation.inviteeRole };
  }

  async markViewed(invitationId: string, actingUserId: string): Promise<RelationshipInvitationRecord> {
    const invitation = await this.requireInvitation(invitationId);
    this.requireInviteeMatch(invitation, actingUserId, null);
    if (invitation.status !== "sent") return invitation;
    const updated = await this.deps.invitations.markViewed(invitationId);
    await this.recordAudit(invitation.relationshipId, actingUserId, "RELATIONSHIP_INVITATION_VIEWED", { invitationId });
    return updated;
  }

  /**
   * Idempotent: a repeated identical acceptance (same invitation, same resolved user) returns the
   * already-accepted state rather than erroring — "duplicate/replayed acceptance remains idempotent."
   */
  async acceptInvitation(input: {
    invitationId: string;
    actingUserId: string;
    actingParty: PartyRef;
    rawToken?: string;
  }): Promise<RelationshipRecord> {
    const invitation = await this.requireInvitation(input.invitationId);
    if (invitation.status === "accepted") {
      this.requireInviteeMatch(invitation, input.actingUserId, input.rawToken ?? null);
      const relationship = await this.deps.relationships.findById(invitation.relationshipId);
      if (!relationship) throw new ValidationError("Relationship not found.");
      return relationship;
    }
    if (invitation.status !== "sent" && invitation.status !== "viewed") {
      throw new ValidationError(`This invitation is no longer open (status "${invitation.status}").`);
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      await this.deps.invitations.markExpired(invitation.id);
      throw new ValidationError("This invitation has expired.");
    }
    this.requireInviteeMatch(invitation, input.actingUserId, input.rawToken ?? null);
    await this.authorizeParty(input.actingUserId, input.actingParty, "send_invitation");

    // PRSprint 31: claim the "accepted" state atomically *first* — before creating the participant
    // or any other side effect — so a concurrent cancelInvitation/declineInvitation either loses this
    // race cleanly (this call proceeds, that one gets `null` and reports "no longer open") or wins it
    // cleanly (we get `null` here and throw *before* anything else has been created; nothing to roll
    // back). The reverse ordering — insert the participant, then discover we lost the race — would
    // leave an orphaned participant row implying acceptance succeeded when it didn't.
    const updated = await this.deps.invitations.markAccepted(invitation.id);
    if (!updated) {
      // Lost the race — find out what actually won. If it was a genuinely concurrent duplicate of
      // this same acceptance (e.g. a double-click), stay idempotent rather than erroring: the pre-
      // existing "repeated acceptance is idempotent" guarantee must hold under true concurrency, not
      // just sequential replay. Only a *different* outcome (cancelled/declined) is a real error.
      const current = await this.requireInvitation(invitation.id);
      if (current.status === "accepted") {
        const relationship = await this.deps.relationships.findById(current.relationshipId);
        if (relationship) return relationship;
      }
      throw new ValidationError("This invitation is no longer open — it was cancelled or declined just now.");
    }

    await this.deps.participants.insert({
      relationshipId: invitation.relationshipId,
      individualProfileId: input.actingParty.kind === "personal" ? input.actingParty.id : null,
      organizationId: input.actingParty.kind === "business" ? input.actingParty.id : null,
      role: invitation.inviteeRole,
      status: "active",
      representedByUserId: input.actingUserId,
      joinedAt: new Date(),
    });
    if (!invitation.resolvedInviteeUserId) {
      await this.deps.invitations.setResolvedInviteeUser(invitation.id, input.actingUserId);
    }
    await this.deps.relationships.markCounterpartyLinked(invitation.relationshipId);

    await this.recordAudit(invitation.relationshipId, input.actingUserId, "RELATIONSHIP_INVITATION_ACCEPTED", { invitationId: invitation.id });
    await this.recordAudit(invitation.relationshipId, input.actingUserId, "RELATIONSHIP_PARTICIPANT_LINKED", { role: invitation.inviteeRole });
    await this.recordAudit(invitation.relationshipId, input.actingUserId, "RELATIONSHIP_ROLE_CONFIRMED", { role: invitation.inviteeRole });

    // Both participants are now known, authenticated PAY2PAY account holders acting for an owned,
    // already-verified profile (authorizeParty above requires this) — this codebase has no separate
    // in-relationship identity-confirmation step beyond that existing profile-ownership verification
    // (Sprint 3 personal profiles / Sprint 9 KYC-gated business verification), so "identities_confirmed"
    // is reached in the same beat as counterparty linkage rather than left as a dead, never-set state.
    // The relationship then immediately becomes eligible for financial account setup.
    await this.deps.relationships.updateStatus(invitation.relationshipId, "identities_confirmed");
    await this.recordAudit(invitation.relationshipId, input.actingUserId, "RELATIONSHIP_PARTY_CONFIRMED", { role: invitation.inviteeRole });
    const relationship = await this.deps.relationships.updateStatus(invitation.relationshipId, "financial_setup_pending");
    await this.deps.notifications.notify({
      recipientUserId: invitation.inviterUserId,
      notificationType: "relationship_accepted",
      relatedAgreementId: null,
      payload: { relationshipId: invitation.relationshipId, invitationId: invitation.id },
      dedupeKey: `relationship_accepted:${invitation.id}`,
    });
    return relationship;
  }

  /** Accepts an optional rawToken — mirrors acceptInvitation's identity proof exactly, since a not-yet-registered invitee has no `resolvedInviteeUserId` to match against and must decline the same way they would accept: by presenting the one-time token from their own email. */
  async declineInvitation(input: { invitationId: string; actingUserId: string; rawToken?: string }): Promise<RelationshipInvitationRecord> {
    const invitation = await this.requireInvitation(input.invitationId);
    if (invitation.status !== "sent" && invitation.status !== "viewed") {
      throw new ValidationError(`This invitation is no longer open (status "${invitation.status}").`);
    }
    this.requireInviteeMatch(invitation, input.actingUserId, input.rawToken ?? null);

    const updated = await this.deps.invitations.markDeclined(invitation.id);
    if (!updated) {
      throw new ValidationError("This invitation is no longer open — it was already accepted or cancelled.");
    }
    await this.recordAudit(invitation.relationshipId, input.actingUserId, "RELATIONSHIP_INVITATION_DECLINED", { invitationId: invitation.id });
    await this.cancelRelationshipIfNeverLinked(invitation.relationshipId, input.actingUserId);
    await this.deps.notifications.notify({
      recipientUserId: invitation.inviterUserId,
      notificationType: "relationship_declined",
      relatedAgreementId: null,
      payload: { relationshipId: invitation.relationshipId, invitationId: invitation.id },
      dedupeKey: `relationship_declined:${invitation.id}`,
    });
    return updated;
  }

  async cancelInvitation(input: { invitationId: string; actingUserId: string }): Promise<RelationshipInvitationRecord> {
    const invitation = await this.requireInvitation(input.invitationId);
    if (invitation.inviterUserId !== input.actingUserId) {
      throw new ForbiddenError("Only the party who created this invitation may cancel it.");
    }
    if (invitation.status !== "sent" && invitation.status !== "viewed") {
      throw new ValidationError(`This invitation is no longer open (status "${invitation.status}").`);
    }
    const updated = await this.deps.invitations.markCancelled(invitation.id);
    if (!updated) {
      throw new ValidationError("This invitation is no longer open — the recipient already accepted or declined it.");
    }
    await this.recordAudit(invitation.relationshipId, input.actingUserId, "RELATIONSHIP_INVITATION_CANCELLED", { invitationId: invitation.id });
    await this.cancelRelationshipIfNeverLinked(invitation.relationshipId, input.actingUserId);
    return updated;
  }

  /**
   * A relationship row is created eagerly at `createInvitation` time, in status `invited`. If its one
   * invitation is declined or cancelled before any counterparty ever links (relationship never left
   * `invited`), the relationship itself has no path forward — mark it `cancelled` rather than leaving
   * an orphaned row stuck in `invited` forever. If the relationship already progressed past `invited`
   * (e.g. a different, since-accepted invitation), this is a no-op — the relationship stays exactly as
   * it is regardless of an unrelated invitation's own outcome.
   */
  private async cancelRelationshipIfNeverLinked(relationshipId: string, actingUserId: string | null): Promise<void> {
    const relationship = await this.deps.relationships.findById(relationshipId);
    if (relationship?.status === "invited") {
      await this.deps.relationships.updateStatus(relationshipId, "cancelled");
      await this.recordAudit(relationshipId, actingUserId, "RELATIONSHIP_CANCELLED", null);
    }
  }

  /**
   * Cron-firing entry point (Sprint 13's established scheduler-abstraction precedent) — see
   * `src/app/api/scheduler/expire-relationship-invitations/route.ts`. An expired invitation is the
   * same "this relationship's only path forward just closed" event as an explicit decline/cancel — see
   * `cancelRelationshipIfNeverLinked`'s own doc comment — so this method applies the identical cleanup,
   * with a null `actingUserId` (a system/scheduler action, not a user action, mirroring this method's
   * own pre-existing `recordAudit(..., null, "RELATIONSHIP_INVITATION_EXPIRED", ...)` call immediately
   * below). Idempotent: `findDueForExpiry` only ever returns invitations still `sent`/`viewed`, so a
   * repeated call (this route firing twice, an overlapping cron invocation) finds nothing left to do.
   */
  async expireDueInvitations(now: Date = new Date()): Promise<{ expired: number }> {
    const due = await this.deps.invitations.findDueForExpiry(now);
    for (const invitation of due) {
      await this.deps.invitations.markExpired(invitation.id);
      await this.recordAudit(invitation.relationshipId, null, "RELATIONSHIP_INVITATION_EXPIRED", { invitationId: invitation.id });
      await this.cancelRelationshipIfNeverLinked(invitation.relationshipId, null);
    }
    return { expired: due.length };
  }

  async listInvitationsForRelationship(relationshipId: string): Promise<RelationshipInvitationRecord[]> {
    return this.deps.invitations.findByRelationshipId(relationshipId);
  }

  /**
   * The one place this class trusts a hash-only lookup with no other authorization check — deliberately
   * narrow (token-verified callers only: resolveInvitationByToken never reveals more than status/email/
   * role, and acceptInvitation immediately re-validates full status/expiry/party authorization before
   * this record is ever acted on).
   */
  private async findByTokenHashUnsafe(tokenHash: string): Promise<RelationshipInvitationRecord | null> {
    // Implemented via the same repository the rest of this class uses — no separate storage.
    return this.deps.invitations.findByTokenHash(tokenHash);
  }

  private requireInviteeMatch(invitation: RelationshipInvitationRecord, actingUserId: string, rawToken: string | null): void {
    if (invitation.resolvedInviteeUserId) {
      if (invitation.resolvedInviteeUserId !== actingUserId) {
        throw new ForbiddenError("This invitation is not addressed to you.");
      }
      return;
    }
    if (rawToken && hashOpaqueToken(rawToken) === invitation.tokenHash) {
      return;
    }
    throw new ForbiddenError("This invitation could not be verified for your account.");
  }

  private async requireInvitation(id: string): Promise<RelationshipInvitationRecord> {
    const invitation = await this.deps.invitations.findById(id);
    if (!invitation) throw new ValidationError("Invitation not found.");
    return invitation;
  }

  /** Mirrors AgreementService's own private authorizeParty exactly — see this class's doc comment for why it's duplicated rather than reused. */
  private async authorizeParty(actingUserId: string, party: PartyRef, requiredCapability: Capability | null): Promise<void> {
    if (party.kind === "personal") {
      const ownerUserId = await this.deps.profileOwners.getOwnerUserId("personal", party.id);
      if (ownerUserId !== actingUserId) {
        throw new ForbiddenError("You do not have access to this profile.");
      }
      return;
    }
    const ownerUserId = await this.deps.profileOwners.getOwnerUserId("business", party.id);
    if (ownerUserId === actingUserId) return;
    if (requiredCapability) {
      await this.deps.staffService.requireCapability(party.id, actingUserId, requiredCapability);
    } else {
      await this.deps.staffService.requireActiveStaff(party.id, actingUserId);
    }
  }

  private async recordAudit(relationshipId: string, actorUserId: string | null, action: string, newValue: unknown): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: actorUserId ? "agreement_party" : "scheduler",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue: null,
      newValue,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: relationshipId,
      targetResourceType: "relationship",
      targetResourceId: relationshipId,
    });
  }
}
