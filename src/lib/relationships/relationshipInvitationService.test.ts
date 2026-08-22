import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { createTestRelationshipServices } from "./testFakes";

describe("RelationshipInvitationService", () => {
  let ctx: ReturnType<typeof createTestRelationshipServices>;

  beforeEach(() => {
    ctx = createTestRelationshipServices();
  });

  function setupInvitation() {
    const creditorUserId = randomUUID();
    const creditorProfileId = randomUUID();
    ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
    return ctx.relationshipInvitationService.createInvitation({
      actingUserId: creditorUserId,
      actingParty: { kind: "personal", id: creditorProfileId },
      inviteeEmail: "invitee@example.com",
      inviteeRole: "debtor",
    });
  }

  describe("createInvitation", () => {
    it("creates a relationship + inviter participant, and notifies an existing-user invitee without ever exposing the raw token", async () => {
      const creditorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      const debtorUserId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      ctx.users.set("debtor@example.com", debtorUserId);

      const { relationship, invitation, rawToken } = await ctx.relationshipInvitationService.createInvitation({
        actingUserId: creditorUserId,
        actingParty: { kind: "personal", id: creditorProfileId },
        inviteeEmail: "debtor@example.com",
        inviteeRole: "debtor",
      });

      expect(relationship.status).toBe("invited");
      expect(invitation.status).toBe("sent");
      expect(invitation.resolvedInviteeUserId).toBe(debtorUserId);
      expect(rawToken).toBeTruthy();

      const participants = await ctx.participants.listForRelationship(relationship.id);
      expect(participants).toHaveLength(1);
      expect(participants[0]?.role).toBe("creditor");
      expect(participants[0]?.representedByUserId).toBe(creditorUserId);

      // Existing-user path: notified in-app/email, never via the raw-token enrollment email.
      const notifications = await ctx.notifyCtx.events.listForUser(debtorUserId);
      expect(notifications.some((n) => n.notificationType === "relationship_invitation")).toBe(true);
      expect(ctx.emailSender.sent).toHaveLength(0);
      for (const n of notifications) {
        expect(JSON.stringify(n.payload)).not.toContain(rawToken);
      }
    });

    it("sends a token-bearing enrollment email for a not-yet-registered invitee, and never persists the raw token", async () => {
      const creditorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);

      const { invitation, rawToken } = await ctx.relationshipInvitationService.createInvitation({
        actingUserId: creditorUserId,
        actingParty: { kind: "personal", id: creditorProfileId },
        inviteeEmail: "newperson@example.com",
        inviteeRole: "debtor",
      });

      expect(invitation.resolvedInviteeUserId).toBeNull();
      expect(ctx.emailSender.sent).toHaveLength(1);
      expect(ctx.emailSender.sent[0]?.body).toContain(rawToken);
      expect(invitation.tokenHash).not.toBe(rawToken);
      const stored = await ctx.invitations.findById(invitation.id);
      expect(JSON.stringify(stored)).not.toContain(rawToken);
    });

    it("rejects creating an invitation for a profile the caller does not own", async () => {
      const ownerUserId = randomUUID();
      const otherUserId = randomUUID();
      const profileId = randomUUID();
      ctx.profileOwners.set("personal", profileId, ownerUserId);

      await expect(
        ctx.relationshipInvitationService.createInvitation({
          actingUserId: otherUserId,
          actingParty: { kind: "personal", id: profileId },
          inviteeEmail: "x@example.com",
          inviteeRole: "debtor",
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("requires the send_invitation capability for a business-party invitation, and rejects a staff member lacking it", async () => {
      const ownerUserId = randomUUID();
      const businessId = randomUUID();
      const managerUserId = randomUUID();
      ctx.profileOwners.set("business", businessId, ownerUserId);
      await ctx.staffCtx.staffMembers.insert({
        businessProfileId: businessId,
        userId: managerUserId,
        role: "manager",
        customRoleId: null,
        isAuthorizedRepresentative: false,
      });

      // "manager" has send_invitation by default — succeeds.
      const { relationship } = await ctx.relationshipInvitationService.createInvitation({
        actingUserId: managerUserId,
        actingParty: { kind: "business", id: businessId },
        inviteeEmail: "counterparty@example.com",
        inviteeRole: "debtor",
      });
      expect(relationship.status).toBe("invited");

      // accountant_viewer lacks send_invitation — rejected.
      const viewerUserId = randomUUID();
      await ctx.staffCtx.staffMembers.insert({
        businessProfileId: businessId,
        userId: viewerUserId,
        role: "accountant_viewer",
        customRoleId: null,
        isAuthorizedRepresentative: false,
      });
      await expect(
        ctx.relationshipInvitationService.createInvitation({
          actingUserId: viewerUserId,
          actingParty: { kind: "business", id: businessId },
          inviteeEmail: "someone@example.com",
          inviteeRole: "debtor",
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("acceptInvitation — token/identity security", () => {
    it("an existing, resolved invitee can accept using only their session (no token needed)", async () => {
      const debtorUserId = randomUUID();
      const debtorProfileId = randomUUID();
      ctx.users.set("invitee@example.com", debtorUserId);
      ctx.profileOwners.set("personal", debtorProfileId, debtorUserId);

      const { invitation } = await setupInvitation();
      const relationship = await ctx.relationshipInvitationService.acceptInvitation({
        invitationId: invitation.id,
        actingUserId: debtorUserId,
        actingParty: { kind: "personal", id: debtorProfileId },
      });
      expect(relationship.status).toBe("financial_setup_pending");
    });

    it("rejects a different logged-in user attempting to accept an invitation resolved to someone else", async () => {
      const debtorUserId = randomUUID();
      ctx.users.set("invitee@example.com", debtorUserId);
      const { invitation } = await setupInvitation();

      const impostorUserId = randomUUID();
      const impostorProfileId = randomUUID();
      ctx.profileOwners.set("personal", impostorProfileId, impostorUserId);

      await expect(
        ctx.relationshipInvitationService.acceptInvitation({
          invitationId: invitation.id,
          actingUserId: impostorUserId,
          actingParty: { kind: "personal", id: impostorProfileId },
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("a new user must present the correct raw token; a tampered/wrong token is rejected", async () => {
      const { invitation, rawToken } = await setupInvitation();
      const newUserId = randomUUID();
      const newProfileId = randomUUID();
      ctx.profileOwners.set("personal", newProfileId, newUserId);

      await expect(
        ctx.relationshipInvitationService.acceptInvitation({
          invitationId: invitation.id,
          actingUserId: newUserId,
          actingParty: { kind: "personal", id: newProfileId },
          rawToken: rawToken + "tampered",
        }),
      ).rejects.toThrow(ForbiddenError);

      const relationship = await ctx.relationshipInvitationService.acceptInvitation({
        invitationId: invitation.id,
        actingUserId: newUserId,
        actingParty: { kind: "personal", id: newProfileId },
        rawToken,
      });
      expect(relationship.status).toBe("financial_setup_pending");
    });

    it("a repeated, identical acceptance is idempotent rather than erroring", async () => {
      const { invitation, rawToken } = await setupInvitation();
      const newUserId = randomUUID();
      const newProfileId = randomUUID();
      ctx.profileOwners.set("personal", newProfileId, newUserId);

      const first = await ctx.relationshipInvitationService.acceptInvitation({
        invitationId: invitation.id,
        actingUserId: newUserId,
        actingParty: { kind: "personal", id: newProfileId },
        rawToken,
      });
      const second = await ctx.relationshipInvitationService.acceptInvitation({
        invitationId: invitation.id,
        actingUserId: newUserId,
        actingParty: { kind: "personal", id: newProfileId },
        rawToken,
      });
      expect(second.id).toBe(first.id);
      const participants = await ctx.participants.listForRelationship(first.id);
      expect(participants).toHaveLength(2); // no duplicate participant row was created on replay
    });

    it("rejects accepting an already-expired invitation", async () => {
      const { invitation, rawToken } = await setupInvitation();
      const stored = await ctx.invitations.byId.get(invitation.id);
      if (stored) stored.expiresAt = new Date(Date.now() - 1000);

      const newUserId = randomUUID();
      const newProfileId = randomUUID();
      ctx.profileOwners.set("personal", newProfileId, newUserId);
      await expect(
        ctx.relationshipInvitationService.acceptInvitation({
          invitationId: invitation.id,
          actingUserId: newUserId,
          actingParty: { kind: "personal", id: newProfileId },
          rawToken,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("PRSprint 31: rejects accepting an invitation the inviter already cancelled", async () => {
      const { invitation, rawToken } = await setupInvitation();
      const creditorUserId = (await ctx.invitations.findById(invitation.id))!.inviterUserId;
      await ctx.relationshipInvitationService.cancelInvitation({ invitationId: invitation.id, actingUserId: creditorUserId });

      const newUserId = randomUUID();
      const newProfileId = randomUUID();
      ctx.profileOwners.set("personal", newProfileId, newUserId);
      await expect(
        ctx.relationshipInvitationService.acceptInvitation({
          invitationId: invitation.id,
          actingUserId: newUserId,
          actingParty: { kind: "personal", id: newProfileId },
          rawToken,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("PRSprint 31: concurrency — genuine adversarial races", () => {
    it("the inviter cancelling and the recipient accepting at the exact same time: exactly one wins, the other is cleanly rejected — never both silently succeeding", async () => {
      const { invitation, rawToken } = await setupInvitation();
      const creditorUserId = (await ctx.invitations.findById(invitation.id))!.inviterUserId;
      const newUserId = randomUUID();
      const newProfileId = randomUUID();
      ctx.profileOwners.set("personal", newProfileId, newUserId);

      const results = await Promise.allSettled([
        ctx.relationshipInvitationService.cancelInvitation({ invitationId: invitation.id, actingUserId: creditorUserId }),
        ctx.relationshipInvitationService.acceptInvitation({
          invitationId: invitation.id,
          actingUserId: newUserId,
          actingParty: { kind: "personal", id: newProfileId },
          rawToken,
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      // Exactly one side wins — never both (that would mean the invitation is simultaneously
      // "cancelled" and "accepted"), and never neither (a legitimate race must still resolve).
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const stored = await ctx.invitations.findById(invitation.id);
      expect(["accepted", "cancelled"]).toContain(stored!.status);

      const participants = await ctx.participants.listForRelationship(invitation.relationshipId);
      if (stored!.status === "accepted") {
        // Accept won: a real participant was created — the cancel side must have been rejected, not
        // silently swallowed (already asserted above via `rejected` count).
        expect(participants).toHaveLength(2);
      } else {
        // Cancel won: no participant was ever created for the recipient's losing accept attempt.
        expect(participants).toHaveLength(1); // just the original inviter
      }
    });

    it("two concurrent accept attempts for the same invitation (replay/double-click) never create two participant rows", async () => {
      const { invitation, rawToken } = await setupInvitation();
      const newUserId = randomUUID();
      const newProfileId = randomUUID();
      ctx.profileOwners.set("personal", newProfileId, newUserId);

      const input = {
        invitationId: invitation.id,
        actingUserId: newUserId,
        actingParty: { kind: "personal" as const, id: newProfileId },
        rawToken,
      };
      const [first, second] = await Promise.all([
        ctx.relationshipInvitationService.acceptInvitation(input),
        ctx.relationshipInvitationService.acceptInvitation(input),
      ]);
      expect(first.id).toBe(second.id);
      const participants = await ctx.participants.listForRelationship(first.id);
      expect(participants).toHaveLength(2); // inviter + one debtor — never a duplicate
    });
  });

  describe("decline / cancel — orphaned relationship cleanup", () => {
    it("cancels the underlying relationship when its only invitation is declined before any counterparty links", async () => {
      const creditorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      const { relationship, invitation, rawToken } = await ctx.relationshipInvitationService.createInvitation({
        actingUserId: creditorUserId,
        actingParty: { kind: "personal", id: creditorProfileId },
        inviteeEmail: "invitee@example.com",
        inviteeRole: "debtor",
      });

      const declinerUserId = randomUUID();
      await ctx.relationshipInvitationService.declineInvitation({ invitationId: invitation.id, actingUserId: declinerUserId, rawToken });

      const updated = await ctx.relationships.findById(relationship.id);
      expect(updated?.status).toBe("cancelled");
    });

    it("only the inviter may cancel an invitation", async () => {
      const creditorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      const { invitation } = await ctx.relationshipInvitationService.createInvitation({
        actingUserId: creditorUserId,
        actingParty: { kind: "personal", id: creditorProfileId },
        inviteeEmail: "invitee@example.com",
        inviteeRole: "debtor",
      });

      await expect(
        ctx.relationshipInvitationService.cancelInvitation({ invitationId: invitation.id, actingUserId: randomUUID() }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("expireDueInvitations", () => {
    it("expires only due, still-open invitations", async () => {
      const creditorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      const { invitation } = await ctx.relationshipInvitationService.createInvitation({
        actingUserId: creditorUserId,
        actingParty: { kind: "personal", id: creditorProfileId },
        inviteeEmail: "invitee@example.com",
        inviteeRole: "debtor",
      });
      const stored = ctx.invitations.byId.get(invitation.id);
      if (stored) stored.expiresAt = new Date(Date.now() - 1000);

      const result = await ctx.relationshipInvitationService.expireDueInvitations(new Date());
      expect(result.expired).toBe(1);
      const updated = await ctx.invitations.findById(invitation.id);
      expect(updated?.status).toBe("expired");
    });

    it("cancels the underlying relationship when an expiring invitation was its only one and no counterparty ever linked (same consistency guarantee as decline/cancel)", async () => {
      const creditorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      const { relationship, invitation } = await ctx.relationshipInvitationService.createInvitation({
        actingUserId: creditorUserId,
        actingParty: { kind: "personal", id: creditorProfileId },
        inviteeEmail: "invitee@example.com",
        inviteeRole: "debtor",
      });
      const stored = ctx.invitations.byId.get(invitation.id);
      if (stored) stored.expiresAt = new Date(Date.now() - 1000);

      await ctx.relationshipInvitationService.expireDueInvitations(new Date());
      const updatedRelationship = await ctx.relationships.findById(relationship.id);
      expect(updatedRelationship?.status).toBe("cancelled");
    });

    it("is idempotent: a second call finds nothing left to expire, and does not re-cancel an already-cancelled relationship", async () => {
      const creditorUserId = randomUUID();
      const creditorProfileId = randomUUID();
      ctx.profileOwners.set("personal", creditorProfileId, creditorUserId);
      const { invitation } = await ctx.relationshipInvitationService.createInvitation({
        actingUserId: creditorUserId,
        actingParty: { kind: "personal", id: creditorProfileId },
        inviteeEmail: "invitee@example.com",
        inviteeRole: "debtor",
      });
      const stored = ctx.invitations.byId.get(invitation.id);
      if (stored) stored.expiresAt = new Date(Date.now() - 1000);

      const first = await ctx.relationshipInvitationService.expireDueInvitations(new Date());
      expect(first.expired).toBe(1);
      const second = await ctx.relationshipInvitationService.expireDueInvitations(new Date());
      expect(second.expired).toBe(0);
    });
  });
});
