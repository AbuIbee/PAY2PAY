import "server-only";
import type { AuditService } from "@/lib/audit/auditService";
import type { AgreementService, DraftTermsInput, PartyRole } from "@/lib/agreements/agreementService";
import { buildTerms } from "@/lib/agreements/agreementService";
import { isPastDate } from "@/lib/agreements/schedule";
import { generateOpaqueToken, hashOpaqueToken } from "@/lib/auth/token";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { normalizeE164 } from "@/lib/phone";
import type { EmailSender } from "@/lib/notify/emailSender";
import type { NotificationService } from "@/lib/notify/notificationService";
import type { ProfileKind, ProfileOwnerReader } from "@/lib/profiles/verificationService";
import type { Capability } from "@/lib/staff/capabilities";
import type { StaffService } from "@/lib/staff/staffService";

export type AgreementInvitationStatus = "pending" | "viewed" | "accepted" | "declined" | "expired" | "revoked";

/** Everything `buildTerms`/`computeSchedule` needs except the two closed-vocabulary fields, which get their own typed columns (mirrors `agreement_version`'s own split). */
export type AgreementInvitationProposedTerms = Omit<DraftTermsInput, "frequency" | "feeAllocation">;

export interface ProfileRef {
  kind: ProfileKind;
  id: string;
}

export interface AgreementInvitationRecord {
  id: string;
  inviterUserId: string;
  inviterProfileKind: ProfileKind;
  inviterProfileId: string;
  inviterRole: PartyRole;
  recipientName: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  recipientUserId: string | null;
  recipientProfileKind: ProfileKind | null;
  recipientProfileId: string | null;
  agreementId: string | null;
  currency: string;
  frequency: DraftTermsInput["frequency"];
  feeAllocation: DraftTermsInput["feeAllocation"];
  proposedTerms: AgreementInvitationProposedTerms;
  message: string | null;
  proposalVersion: number;
  tokenHash: string;
  status: AgreementInvitationStatus;
  expiresAt: Date;
  openedAt: Date | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  revokedAt: Date | null;
  claimedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Real implementation: DrizzleAgreementInvitationRepository. */
export interface AgreementInvitationRepository {
  insert(input: {
    inviterUserId: string;
    inviterProfileKind: ProfileKind;
    inviterProfileId: string;
    inviterRole: PartyRole;
    recipientName: string | null;
    recipientEmail: string | null;
    recipientPhone: string | null;
    recipientUserId: string | null;
    currency: string;
    frequency: DraftTermsInput["frequency"];
    feeAllocation: DraftTermsInput["feeAllocation"];
    proposedTerms: AgreementInvitationProposedTerms;
    message: string | null;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<AgreementInvitationRecord>;
  findById(id: string): Promise<AgreementInvitationRecord | null>;
  findByTokenHash(tokenHash: string): Promise<AgreementInvitationRecord | null>;
  markOpened(id: string, openedAt: Date): Promise<AgreementInvitationRecord>;
  updateProposedTerms(
    id: string,
    input: {
      frequency: DraftTermsInput["frequency"];
      feeAllocation: DraftTermsInput["feeAllocation"];
      proposedTerms: AgreementInvitationProposedTerms;
      message: string | null;
      proposalVersion: number;
    },
  ): Promise<AgreementInvitationRecord>;
  bindRecipient(id: string, input: { recipientUserId: string; recipientProfileKind: ProfileKind; recipientProfileId: string }): Promise<AgreementInvitationRecord>;
  /**
   * PRSprint 31 (docs/prsprints/PRSPRINT_31_E2E_NEGATIVE_SECURITY_CONCURRENCY_TEST_COMPLETION.md):
   * split from the old single-step `markAccepted(id, {acceptedAt, claimedAt, agreementId})`, which was
   * called only *after* `acceptPlan` had already created and fully activated a real agreement — with
   * no atomic guard on the write. That meant a concurrent `revokeInvitation`/`declinePublic` could
   * "win" (the sender sees a successful revoke, believing no agreement was created) while `acceptPlan`
   * still finished creating and activating one anyway, silently overwriting the revoked/declined
   * status back to "accepted." `claimAcceptance` is now the *first* thing `acceptPlan` does — atomic,
   * `WHERE status IN ('pending','viewed')`, before any agreement is created — so a losing accept never
   * creates an agreement at all. `attachAcceptedAgreement` is the unconditional second step, called
   * only after the claim already succeeded (nothing left to race against).
   */
  claimAcceptance(id: string, acceptedAt: Date): Promise<AgreementInvitationRecord | null>;
  attachAcceptedAgreement(id: string, input: { claimedAt: Date; agreementId: string }): Promise<AgreementInvitationRecord>;
  markDeclined(id: string, declinedAt: Date): Promise<AgreementInvitationRecord | null>;
  markRevoked(id: string, revokedAt: Date): Promise<AgreementInvitationRecord | null>;
  markExpired(id: string): Promise<AgreementInvitationRecord>;
  regenerateToken(id: string, tokenHash: string, expiresAt: Date): Promise<AgreementInvitationRecord>;
  /** Cron-scan entry point, mirroring PaymentRetryRepository/RelationshipInvitationRepository's identical `findDueForFiring`/`findDueForExpiry` precedent. */
  findDueForExpiry(now: Date): Promise<AgreementInvitationRecord[]>;
}

/** Mirrors StaffService's own UserEmailReader interface shape exactly — DrizzleUserEmailReader (src/lib/staff/drizzleUserEmailReader.ts) already implements this generically against user_account and is reused directly. */
export interface UserEmailReader {
  getEmailByUserId(userId: string): Promise<string | null>;
}

/** Mirrors RelationshipInvitationService's own UserLookupReader interface shape exactly — DrizzleUserLookupReader (src/lib/relationships/drizzleUserLookupReader.ts) already implements this generically and is reused directly. */
export interface UserLookupReader {
  findUserIdByEmail(email: string): Promise<string | null>;
}

/**
 * Codex B0-B blocker correction (B0-B-003): a phone lookup must be able to say "more than one distinct
 * registered user has an active, verified credential for this exact phone" — never silently pick one.
 * `no_match` / `unique_match` / `ambiguous_match` are the only three honest answers; there is no
 * fourth "pick the most recent" outcome. Two credentials belonging to the SAME user are not ambiguity
 * (see `DrizzleRegisteredPhoneReader`'s own doc comment) — the security condition is strictly "more
 * than one DISTINCT user id."
 */
export type RegisteredPhoneLookupResult =
  | { kind: "no_match" }
  | { kind: "unique_match"; userId: string }
  | { kind: "ambiguous_match" };

/**
 * B0-B blocker correction: the canonical phone<->user relationship, distinct from `UserLookupReader`
 * above (which resolves by email against `user_account` directly) — `user_account.phone` is a dead,
 * always-null column (see DrizzleUserContactReader's own doc comment), so the only proof this
 * codebase has that a phone number belongs to a specific registered user is a verified SMS MFA
 * credential. Real implementation: DrizzleRegisteredPhoneReader (src/lib/notify/).
 */
export interface RegisteredPhoneReader {
  findUserIdByVerifiedPhone(phone: string): Promise<RegisteredPhoneLookupResult>;
}

/** Real implementation: DrizzleProfileDisplayReader. Never exposes anything beyond a display-safe name — no email, no internal id, no verification/KYC state. */
export interface ProfileDisplayReader {
  getDisplayName(profileKind: ProfileKind, profileId: string): Promise<{ displayName: string; businessName: string | null }>;
}

export interface PublicInvitationView {
  senderDisplayName: string;
  senderBusinessName: string | null;
  amountMinorUnits: number;
  currency: string;
  paymentFrequency: DraftTermsInput["frequency"];
  firstPaymentDate: string;
  numberOfPayments: number;
  totalRepaymentMinorUnits: number;
  feeAllocation: DraftTermsInput["feeAllocation"];
  message: string | null;
  proposalVersion: number;
  status: AgreementInvitationStatus;
  expiresAt: string;
}

export interface AgreementInvitationServiceDeps {
  invitations: AgreementInvitationRepository;
  agreements: AgreementService;
  profileOwners: ProfileOwnerReader;
  profileDisplay: ProfileDisplayReader;
  staffService: StaffService;
  users: UserLookupReader;
  /**
   * B0-B blocker correction: resolves a `recipientPhone` to a registered user's own id via their
   * verified MFA phone — the second (alongside email) canonical signal `createInvitation` uses to
   * decide whether an invitation recipient is an existing Paid2You user. See this class's own
   * `createInvitation` doc comment for exactly how this feeds the automated-SMS gate.
   */
  registeredPhones: RegisteredPhoneReader;
  userEmails: UserEmailReader;
  /**
   * B0-B blocker correction: the ONLY way this class ever triggers an automated SMS — see
   * `createInvitation`'s own doc comment. There is deliberately no direct `SmsSender`/`SmsOptOutRepository`
   * dependency on this class anymore: routing every automated SMS through `notify()` is what makes
   * `sms_consent`/`sms_opt_out` enforcement structural rather than a second, parallel check this class
   * would otherwise have to keep in sync by hand.
   */
  notifications: NotificationService;
  emailSender: EmailSender;
  audit: AuditService;
  appUrl: string;
}

const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Generic-enough denial message reused across every reason a token can be unusable (not-found / expired / revoked / consumed) — enumeration protection, matching login's own established precedent. */
const INVALID_INVITATION_MESSAGE = "This invitation link is invalid or has expired.";
const OPEN_STATUSES: readonly AgreementInvitationStatus[] = ["pending", "viewed"];

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * PRSprint 10 (docs/prsprints/PRSPRINT_10_INVITATION_IDENTITY_CLAIMING_ACCEPTANCE.md): the
 * anonymous-review invitation bridge — "Create Agreement -> Enter Recipient -> Send Secure Link ->
 * Anonymous Review -> Accept / Request Changes / Decline -> Create or Link Account -> Verify
 * Identity -> Sign / Final Accept -> Payment Setup -> Agreement Active".
 *
 * No real, canonical `agreement` row (Sprint 5) exists until `acceptPlan` — see
 * `src/db/schema/agreementInvitation.ts`'s own doc comment for why (a not-yet-registered recipient
 * has no profile to satisfy `agreement.debtorProfileId`/`creditorProfileId`'s `NOT NULL`
 * constraint, which PRSprint 09 re-confirmed is load-bearing and was deliberately left untouched).
 * Everything before acceptance — the proposal, any Request-Changes rounds — mutates only this
 * invitation row.
 *
 * Negotiation is intentionally symmetric: `proposeTerms` and `acceptPlan` are each callable by
 * *either* side (inviter or the — possibly just-bound — recipient), keyed only on whether
 * `actingUserId` matches `inviterUserId` or the recipient-match rule
 * (`requireRecipientIdentity`). This is what lets one pair of methods serve both "recipient
 * Requests Changes, inviter later re-counters" and "inviter Accepts the recipient's counter"
 * without a second, sender-only code path. A full multi-round mutual-approval negotiation *after*
 * a real agreement exists is PRSprint 11's own scope (Agreement Versioning, Amendments & Mutual
 * Approval) — this class only ever negotiates the *pre-agreement* proposal.
 *
 * Once `acceptPlan` runs, the real agreement is driven through Sprint 5's own existing state
 * machine using its own existing methods (`createDraft` -> `submitDraft` -> `acknowledgeDebt` ->
 * `creditorDecide({decision:"accept"})`) — nothing here reimplements agreement lifecycle logic.
 * Whichever side is the debtor performs the acknowledgment; the creditor side (implicitly, since
 * this proposal was already mutually negotiated through this class before anyone could accept)
 * accepts immediately after, landing the agreement at `awaiting_signatures` — the existing
 * Sprint 6 signature flow and the existing `/agreements/detail` page take over from there
 * ("return the user directly to the agreement").
 */
export class AgreementInvitationService {
  constructor(private readonly deps: AgreementInvitationServiceDeps) {}

  async createInvitation(input: {
    actingUserId: string;
    inviterProfile: ProfileRef;
    inviterRole: PartyRole;
    recipientName?: string | null;
    recipientEmail?: string | null;
    recipientPhone?: string | null;
    currency?: string;
    terms: DraftTermsInput;
    message?: string | null;
  }): Promise<{ invitation: AgreementInvitationRecord; rawToken: string; link: string }> {
    await this.authorizeParty(input.actingUserId, input.inviterProfile, "create_agreement");

    const recipientEmail = input.recipientEmail?.trim() ? normalizeEmail(input.recipientEmail) : null;
    // PRSprint 15 (docs/prsprints/PRSPRINT_15_PRODUCTION_SMS.md), requirement #7: normalized to E.164
    // up front — a phone number stored in whatever format the inviter typed it would both fail at
    // send time (Twilio requires E.164) and encourage the exact "multiple incompatible
    // representations" requirement #7 warns against.
    const recipientPhone = input.recipientPhone?.trim() ? normalizeE164(input.recipientPhone) : null;
    if (input.recipientPhone?.trim() && !recipientPhone) {
      throw new ValidationError("A valid recipient phone number is required (US numbers, or include a country code).");
    }
    const recipientName = input.recipientName?.trim() || null;
    if (!recipientEmail && !recipientPhone && !recipientName) {
      throw new ValidationError("A recipient name, email, or phone number is required.");
    }
    if (recipientEmail && !recipientEmail.includes("@")) {
      throw new ValidationError("A valid recipient email is required.");
    }

    // Validates every proposed-terms field (throws ValidationError on anything malformed) and
    // computes the schedule preview — never persisted separately (see this class's own doc
    // comment), just used here to fail fast on obviously-invalid terms before storing anything.
    buildTerms(input.terms);
    // Agreement Lifecycle V2 UAT (Defect 5 — date picker must not allow a past first payment date):
    // creation-time only, mirrors AgreementService.createDraft's identical new check.
    if (isPastDate(input.terms.firstPaymentDate)) {
      throw new ValidationError("First payment date cannot be in the past.");
    }

    const { frequency, feeAllocation, ...proposedTerms } = input.terms;

    // Codex B0-B blocker correction (B0-B-002 / B0-B-003, including the FINAL correction below):
    // email and phone are resolved INDEPENDENTLY, then reconciled — never "email first, phone as a
    // tie-broken fallback" the way the original pass did it, which silently trusted email's answer
    // even when phone pointed at someone else entirely (or was itself unsafe to trust). Outcomes:
    //   - email -> A, phone -> nobody:                        use A.
    //   - email -> nobody, phone -> uniquely B:               use B.
    //   - email -> nobody, phone -> nobody:                   unregistered — no automated SMS.
    //   - email -> A, phone -> uniquely A:                    consistent — use A.
    //   - email -> A, phone -> uniquely B, A !== B:            IDENTITY CONFLICT — use NEITHER. No
    //     automated SMS to either, and no automated account-targeted notification (email/in_app via
    //     notify()) to either — the contradictory signals mean this invitation cannot be safely
    //     attributed to any one account. Recorded to the audit trail as `recipient_identity_conflict`.
    //   - phone -> ambiguous (active verified for more than one DISTINCT user), REGARDLESS of what
    //     email independently resolves (including when email resolves someone uniquely): use NEITHER.
    //     Codex final-review correction (B0-B-003): an ambiguous phone is itself a contradictory,
    //     unsafe signal about the exact destination this invitation supplied — it must never be waved
    //     through merely because a *different* input (email) happened to resolve someone. Recorded to
    //     the audit trail as `recipient_phone_ambiguous`. This is distinct from — and checked before —
    //     the unique-match reconciliation above, so an ambiguous phone can never be miscategorized as
    //     "no phone signal at all" and silently defer to email.
    //   In both suppression cases, the secure invitation link/token is still generated and returned
    //   exactly as normal (Section "SHARING MUST REMAIN AVAILABLE") and, if `recipientEmail` was
    //   supplied, a plain direct email is still sent to it (identical treatment to the "unregistered"
    //   branch below) — only the *automated, account-targeted* notification path is suppressed. Both
    //   audit events omit user id/email/phone (matching this class's own existing PII-minimization
    //   convention for `agreement_invitation_created`'s audit metadata) and are never surfaced to the
    //   inviter — the public invitation-creation response is unaffected either way.
    // In every case, `existingUserId` (and therefore the invitation's own persisted `recipientUserId`
    // binding — see `requireRecipientIdentityAndBind`'s "once bound, only that account may act, ever
    // again" rule) is null unless a single, uncontradicted identity was actually established — neither
    // a conflict nor an ambiguous phone can ever bind the invitation to an arbitrarily-chosen side.
    const emailUserId = recipientEmail ? await this.deps.users.findUserIdByEmail(recipientEmail) : null;
    const phoneLookup = recipientPhone ? await this.deps.registeredPhones.findUserIdByVerifiedPhone(recipientPhone) : ({ kind: "no_match" } as const);

    let existingUserId: string | null = null;
    let recipientIdentityConflict = false;
    let recipientPhoneAmbiguous = false;
    if (phoneLookup.kind === "ambiguous_match") {
      // Checked FIRST, before any email reconciliation: an ambiguous phone must suppress automated
      // account-targeted dispatch unconditionally — even when email independently and uniquely
      // resolves someone (the exact gap the Codex final review found: the prior pass's `else` branch
      // folded "ambiguous_match" together with "no_match" and let email decide alone, which is safe
      // for "no phone signal" but not for "phone signal that is itself contradictory").
      recipientPhoneAmbiguous = true;
    } else if (phoneLookup.kind === "unique_match") {
      if (emailUserId === null) {
        existingUserId = phoneLookup.userId;
      } else if (emailUserId === phoneLookup.userId) {
        existingUserId = emailUserId;
      } else {
        recipientIdentityConflict = true;
      }
    } else {
      // "no_match" — no phone signal at all, so it cannot override or contradict an independently
      // resolved email identity; email decides alone (null if email also didn't resolve anyone).
      existingUserId = emailUserId;
    }

    const rawToken = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(rawToken);
    const expiresAt = new Date(Date.now() + DEFAULT_INVITATION_TTL_MS);
    const invitation = await this.deps.invitations.insert({
      inviterUserId: input.actingUserId,
      inviterProfileKind: input.inviterProfile.kind,
      inviterProfileId: input.inviterProfile.id,
      inviterRole: input.inviterRole,
      recipientName,
      recipientEmail,
      recipientPhone,
      recipientUserId: existingUserId,
      currency: input.currency ?? "USD",
      frequency,
      feeAllocation,
      proposedTerms,
      message: input.message?.trim() || null,
      tokenHash,
      expiresAt,
    });

    const link = `${this.deps.appUrl}/i/${rawToken}`;
    await this.recordAudit(invitation.id, input.actingUserId, "agreement_invitation_created", {
      recipientEmail: recipientEmail ? "provided" : null,
      recipientPhone: recipientPhone ? "provided" : null,
    });
    if (recipientIdentityConflict) {
      // B0-B-002: a safe, internal-only record of exactly why no account-targeted notification was
      // attempted — deliberately no user id embedded (matches this class's own existing
      // PII-minimization convention immediately above, which records "provided"/null for the raw
      // contact values rather than the values themselves). Never surfaced to the inviter — the
      // public invitation-creation response is unaffected either way (see Section "ENUMERATION
      // SAFETY").
      await this.recordAudit(invitation.id, input.actingUserId, "agreement_invitation_recipient_identity_conflict", {
        reason: "recipient_identity_conflict",
      });
    }
    if (recipientPhoneAmbiguous) {
      // B0-B-003 (final correction): a safe, internal-only record of why no account-targeted
      // notification was attempted when the supplied phone was active/verified for more than one
      // distinct user — deliberately no user id, email, or phone embedded, and never surfaced to the
      // inviter (Section "ENUMERATION SAFETY").
      await this.recordAudit(invitation.id, input.actingUserId, "agreement_invitation_recipient_phone_ambiguous", {
        reason: "recipient_phone_ambiguous",
      });
    }

    if (existingUserId) {
      // Existing platform user (recognized by email OR by their own verified MFA phone — see the
      // resolution above) — matches RelationshipInvitationService's own precedent exactly: notify()
      // handles email/sms/in_app dispatch itself, deliberately token-free (the token is never
      // persisted to notification_event.payload — see ctaOverride's own doc comment on
      // NotificationService.notify for why this is a transient, non-persisted parameter rather than a
      // stored relatedX id: neither of buildCtaUrl's two existing routes applies to this pre-agreement,
      // secure-token invitation).
      //
      // B0-B blocker correction: this is now the ONLY path by which this class ever triggers an
      // automated SMS. notify() resolves the actual destination phone from `existingUserId`'s own
      // canonical contact info (never from the inviter-supplied `recipientPhone`) and applies its own
      // `sms_consent`/`sms_opt_out` gate uniformly — an automated SMS reaches this recipient if and
      // only if they have active, durable, web-form consent and have not opted out via STOP. Nothing
      // here needs to duplicate that decision.
      //
      // Production follow-up (missing CTA defect): this call previously omitted any CTA at all, so
      // NotificationService.buildCtaUrl had nothing to build a link from (relatedAgreementId is
      // genuinely null pre-acceptance; relatedInvitationId's own route is the unrelated relationship-
      // invitation flow) — the email rendered with no return link. ctaOverride passes the same secure
      // `/i/<token>` link the "not yet registered" branch below sends directly, so both recipient
      // types get an identical, working CTA from the one existing invitation-link/route.
      await this.deps.notifications.notify({
        recipientUserId: existingUserId,
        notificationType: "agreement_invitation",
        relatedAgreementId: null,
        payload: { counterpartyName: await this.senderDisplayName(input.inviterProfile) },
        dedupeKey: `agreement_invitation:${invitation.id}:${existingUserId}`,
        ctaOverride: { ctaUrl: link, ctaText: "Review agreement" },
      });
    } else {
      // Reached for FOUR distinct reasons, all handled identically and safely: (1) genuinely
      // unregistered — neither email nor phone resolved anyone; (2) B0-B-003 — the supplied phone was
      // ambiguous across distinct users, REGARDLESS of whether email independently resolved someone;
      // (3) B0-B-002 identity conflict — email and phone each uniquely resolved a DIFFERENT registered
      // account. In every case there is no single, safely-attributable account to target with
      // notify()'s recipientUserId-required contract (same rationale as RelationshipInvitationService's
      // own doc comment for the genuinely-unregistered case), so this branch NEVER triggers an
      // automated Twilio SMS and NEVER calls notify() (no automated account-targeted email/in_app
      // notification either, for the ambiguous-phone and conflict cases specifically — see the
      // resolution logic's own doc comment above).
      //
      // A not-yet-registered recipient has never seen Paid2You's own web-form SMS-consent disclosure —
      // there is no account, no session, no prior interaction with Paid2You's UI for them at all — so
      // no consent can be honestly attributed to them, and the inviter's own act of typing in a phone
      // number is not consent from the person that number belongs to (this pass's own frozen product
      // decision, verbatim). Email is unaffected — it is not subject to this pass's SMS/A2P consent
      // rules — and the secure invitation link itself is always generated and returned to the inviter
      // regardless of recipient/consent/conflict state, so sharing is never blocked: the inviter can
      // still use Copy Link, their device's own native share sheet, or WhatsApp (none of which are
      // Paid2You-automated Twilio sends — see InviteToAgreement.tsx).
      if (recipientEmail) {
        const senderName = await this.senderDisplayName(input.inviterProfile);
        await this.deps.emailSender.send({
          to: recipientEmail,
          subject: "You've received a payment plan proposal on PAY2PAY",
          body: `${senderName} has proposed a payment plan for you to review on PAY2PAY. Review it securely, no account required: ${link}\n\nThis link expires in 7 days.`,
          ctaUrl: link,
          ctaText: "Review agreement",
        });
      }
    }
    await this.recordAudit(invitation.id, input.actingUserId, "agreement_invitation_sent", {
      channel: existingUserId ? "in_app_and_email" : "direct",
    });

    return { invitation, rawToken, link };
  }

  /**
   * Unauthenticated-safe. Never mutates anything but `status`/`openedAt`, and only ever forward
   * (pending -> viewed, once) — repeated calls (including automated link-preview scanners) are
   * idempotent and harmless; `viewed` never gates or blocks any subsequent action (this PRSprint's
   * own "do not rely on opened_at as proof of a human view").
   */
  async resolvePublic(rawToken: string): Promise<PublicInvitationView> {
    const invitation = await this.findByTokenOrThrow(rawToken);
    if (invitation.status === "pending") {
      try {
        await this.deps.invitations.markOpened(invitation.id, new Date());
      } catch {
        // Best-effort — a lost race with a concurrent open (or the invitation moving on to a
        // terminal status between the read above and this write) must never break the read.
      }
    }
    return this.toPublicView(invitation);
  }

  /**
   * Either side may propose new terms while the invitation is still open: the recipient's "Request
   * Changes" (requires prior authentication — "Identity verification/account creation is required
   * before formal submission" — and binds their identity on first use, same as `acceptPlan`), or
   * the inviter countering back. Preserves the original proposal implicitly: nothing here ever
   * creates a real `agreement`/`agreement_version`, so there is nothing "original" to lose — the
   * full history is the audit trail (`previousValue`/`newValue` on every `agreement_invitation_
   * terms_updated` event) plus `proposalVersion`, incremented on every round.
   */
  async proposeTerms(input: {
    rawToken: string;
    actingUserId: string;
    actingProfile?: ProfileRef;
    terms: DraftTermsInput;
    message?: string | null;
  }): Promise<AgreementInvitationRecord> {
    const invitation = await this.requireOpenInvitation(await this.findByTokenOrThrow(input.rawToken));
    const isInviter = input.actingUserId === invitation.inviterUserId;
    if (!isInviter) {
      await this.requireRecipientIdentityAndBind(invitation, input.actingUserId, input.actingProfile);
    }

    buildTerms(input.terms);
    const { frequency, feeAllocation, ...proposedTerms } = input.terms;
    const previousTerms = { frequency: invitation.frequency, feeAllocation: invitation.feeAllocation, ...invitation.proposedTerms };
    const updated = await this.deps.invitations.updateProposedTerms(invitation.id, {
      frequency,
      feeAllocation,
      proposedTerms,
      message: input.message?.trim() || invitation.message,
      proposalVersion: invitation.proposalVersion + 1,
    });

    await this.recordAudit(invitation.id, input.actingUserId, "agreement_invitation_terms_proposed", {
      previousTerms,
      newTerms: { frequency, feeAllocation, ...proposedTerms },
      proposalVersion: updated.proposalVersion,
    }, previousTerms);

    const notifyUserId = isInviter ? updated.recipientUserId : invitation.inviterUserId;
    if (notifyUserId) {
      await this.deps.notifications.notify({
        recipientUserId: notifyUserId,
        notificationType: "agreement_invitation_response",
        relatedAgreementId: null,
        payload: { action: "request_changes", proposalVersion: updated.proposalVersion },
        dedupeKey: `agreement_invitation_response:${invitation.id}:${updated.proposalVersion}`,
      });
    }
    return updated;
  }

  /**
   * Finalizes the *current* proposed terms into a real, canonical agreement (Sprint 5) and creates
   * the durable agreement-party relationship. Callable by the recipient (accepting the inviter's
   * terms as-is — Scenarios A/B) or by the inviter (accepting the recipient's counter — the
   * finishing half of Scenario C); either way the recipient's identity must already be bound by
   * this point (either here, for a first-touch Accept, or earlier via `proposeTerms`).
   *
   * Decision 3 (centralized auto-connection): connection establishment is no longer called from
   * here — `AgreementService.creditorDecide`'s own accept branch does it, at the single shared
   * lifecycle boundary every creation path (wizard, invitation, B2B, CSV) reaches, so it is never
   * duplicated between that class and this one. The partial-success contract is unchanged: agreement
   * acceptance (createDraft/submitDraft/acknowledgeDebt/creditorDecide) and connection establishment
   * remain two independently-persisted outcomes — acceptance is authoritative and final the moment
   * `creditorDecide` returns, regardless of whether the best-effort connection step inside it
   * succeeded. This method re-reads the agreement immediately after to report `connectionRequired`
   * accurately rather than assuming success. A retry of `acceptPlan` itself is *not* the recovery
   * path (the invitation is already consumed — see `claimAcceptance` above — so a retry correctly
   * fails closed rather than re-running acceptance); the agreement page's own "Connection required" /
   * `MissingConnectionPanel` recovery UI is.
   */
  async acceptPlan(input: { rawToken: string; actingUserId: string; actingProfile?: ProfileRef }): Promise<{ agreementId: string; connectionRequired: boolean }> {
    const invitation = await this.requireOpenInvitation(await this.findByTokenOrThrow(input.rawToken));
    const isInviter = input.actingUserId === invitation.inviterUserId;
    let bound = invitation;
    if (!isInviter) {
      bound = await this.requireRecipientIdentityAndBind(invitation, input.actingUserId, input.actingProfile);
    } else if (!bound.recipientUserId || !bound.recipientProfileKind || !bound.recipientProfileId) {
      throw new ForbiddenError("There is no recipient response yet for you to accept.");
    }

    // PRSprint 31: claim "accepted" atomically *before* creating any agreement — a concurrent
    // revokeInvitation/declinePublic (or a second concurrent acceptPlan replay — this service treats
    // *any* second accept as an error, matching the pre-existing sequential-replay behavior: "consumed
    // token replay (accept twice) -> denied", never idempotent success) either loses this race cleanly
    // (proceeds below; the other call gets `null` and reports "no longer open") or wins it cleanly (we
    // get `null` here and throw before an agreement has ever been created — nothing to roll back). See
    // claimAcceptance's own doc comment on the repository interface for why the old ordering was a
    // real financial-integrity bug.
    const now = new Date();
    const claimed = await this.deps.invitations.claimAcceptance(bound.id, now);
    if (!claimed) {
      throw new ValidationError("This invitation is no longer open — it was already accepted, revoked, or declined.");
    }

    const inviter: ProfileRef = { kind: bound.inviterProfileKind, id: bound.inviterProfileId };
    const recipient: ProfileRef = { kind: bound.recipientProfileKind!, id: bound.recipientProfileId! };
    const creditor = bound.inviterRole === "creditor" ? inviter : recipient;
    const debtor = bound.inviterRole === "debtor" ? inviter : recipient;
    const debtorUserId = bound.inviterRole === "debtor" ? bound.inviterUserId : bound.recipientUserId!;
    const creditorUserId = bound.inviterRole === "creditor" ? bound.inviterUserId : bound.recipientUserId!;

    const draft = await this.deps.agreements.createDraft({
      creatorUserId: input.actingUserId,
      creditor: { kind: creditor.kind, id: creditor.id },
      debtor: { kind: debtor.kind, id: debtor.id },
      currency: bound.currency,
      frequency: bound.frequency,
      feeAllocation: bound.feeAllocation,
      ...bound.proposedTerms,
    });
    const agreementId = draft.agreement.id;
    await this.deps.agreements.submitDraft(agreementId, input.actingUserId);
    await this.deps.agreements.acknowledgeDebt(agreementId, debtorUserId);
    await this.deps.agreements.creditorDecide({ agreementId, actingUserId: creditorUserId, decision: "accept" });

    // Decision 3: creditorDecide's own accept branch already attempted best-effort connection
    // establishment (and identity-snapshot freezing) internally — re-read the agreement to report
    // truthfully whether it worked, rather than assuming success.
    const afterAccept = await this.deps.agreements.getAgreement(agreementId, input.actingUserId);
    const connectionRequired = !afterAccept.agreement.relationshipId;

    // Unconditional — our claim on "accepted" already succeeded above, so there is nothing left to
    // race against; this just attaches the now-created agreement's id. Runs regardless of
    // connectionRequired — the invitation's own lifecycle (accepted/claimed/agreementId) is complete
    // either way; only the separate connection-linkage outcome differs.
    await this.deps.invitations.attachAcceptedAgreement(bound.id, { claimedAt: new Date(), agreementId });
    await this.recordAudit(bound.id, input.actingUserId, "agreement_invitation_accepted", { agreementId, connectionRequired });

    await this.deps.notifications.notify({
      recipientUserId: bound.inviterUserId === input.actingUserId ? bound.recipientUserId! : bound.inviterUserId,
      notificationType: "agreement_invitation_response",
      relatedAgreementId: agreementId,
      payload: { action: "accepted" },
      dedupeKey: `agreement_invitation_response:${bound.id}:accepted`,
    });
    return { agreementId, connectionRequired };
  }

  /**
   * Deliberately token-only (no authentication required) — declining carries no financial or
   * identity commitment (this PRSprint's own acceptance criteria: "Formal Accept/Counter requires
   * verified identity/account" names only those two, not Decline). Still an explicit POST a human
   * must trigger, never a GET — see `resolvePublic`'s own doc comment for the scanner-safety
   * invariant this preserves.
   */
  async declinePublic(rawToken: string): Promise<void> {
    const invitation = await this.requireOpenInvitation(await this.findByTokenOrThrow(rawToken));
    const declined = await this.deps.invitations.markDeclined(invitation.id, new Date());
    if (!declined) {
      // Lost a genuine race against acceptPlan/revokeInvitation — never report success for a decline
      // that didn't actually take effect.
      throw new ValidationError("This invitation is no longer open — it was already accepted or revoked.");
    }
    await this.recordAudit(invitation.id, null, "agreement_invitation_declined", null);
    await this.deps.notifications.notify({
      recipientUserId: invitation.inviterUserId,
      notificationType: "agreement_invitation_response",
      relatedAgreementId: null,
      payload: { action: "declined" },
      dedupeKey: `agreement_invitation_response:${invitation.id}:declined`,
    });
  }

  async revokeInvitation(invitationId: string, actingUserId: string): Promise<AgreementInvitationRecord> {
    const invitation = await this.requireInvitation(invitationId);
    if (invitation.inviterUserId !== actingUserId) {
      throw new ForbiddenError("Only the sender may revoke this invitation.");
    }
    if (!OPEN_STATUSES.includes(invitation.status)) {
      throw new ValidationError(`This invitation is no longer open (status "${invitation.status}").`);
    }
    const revoked = await this.deps.invitations.markRevoked(invitation.id, new Date());
    if (!revoked) {
      // Lost a genuine race against acceptPlan/declinePublic — never report a successful revoke that
      // didn't actually take effect (the original bug this PRSprint found: a revoke could appear to
      // succeed while acceptPlan finished creating a real agreement anyway).
      throw new ValidationError("This invitation is no longer open — it was just accepted or declined.");
    }
    await this.recordAudit(invitation.id, actingUserId, "agreement_invitation_revoked", null);
    return revoked;
  }

  /** Regenerates the token (the old one stops working immediately) and extends expiry — "resend must be safe." */
  async resendInvitation(invitationId: string, actingUserId: string): Promise<{ invitation: AgreementInvitationRecord; rawToken: string; link: string }> {
    const invitation = await this.requireInvitation(invitationId);
    if (invitation.inviterUserId !== actingUserId) {
      throw new ForbiddenError("Only the sender may resend this invitation.");
    }
    if (!OPEN_STATUSES.includes(invitation.status)) {
      throw new ValidationError(`This invitation is no longer open (status "${invitation.status}").`);
    }
    const rawToken = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(rawToken);
    const expiresAt = new Date(Date.now() + DEFAULT_INVITATION_TTL_MS);
    const updated = await this.deps.invitations.regenerateToken(invitation.id, tokenHash, expiresAt);
    const link = `${this.deps.appUrl}/i/${rawToken}`;
    await this.recordAudit(invitation.id, actingUserId, "agreement_invitation_resent", null);
    if (invitation.recipientEmail) {
      const senderName = await this.senderDisplayName({ kind: invitation.inviterProfileKind, id: invitation.inviterProfileId });
      await this.deps.emailSender.send({
        to: invitation.recipientEmail,
        subject: "Reminder: you have a payment plan proposal on PAY2PAY",
        body: `${senderName} sent you a reminder about a payment plan proposal on PAY2PAY: ${link}\n\nThis link expires in 7 days.`,
        ctaUrl: link,
        ctaText: "Review agreement",
      });
    }
    return { invitation: updated, rawToken, link };
  }

  /**
   * Cron-firing entry point (Sprint 13/18A's established scheduler-abstraction precedent — see
   * RelationshipInvitationService.expireDueInvitations). Idempotent: `findDueForExpiry` only ever
   * selects invitations still `pending`/`viewed` past their `expires_at`.
   */
  async expireDueInvitations(now: Date = new Date()): Promise<{ expired: number }> {
    const due = await this.deps.invitations.findDueForExpiry(now);
    for (const invitation of due) {
      await this.deps.invitations.markExpired(invitation.id);
      await this.recordAudit(invitation.id, null, "agreement_invitation_expired", null);
    }
    return { expired: due.length };
  }

  async getInvitation(invitationId: string, actingUserId: string): Promise<AgreementInvitationRecord> {
    const invitation = await this.requireInvitation(invitationId);
    if (invitation.inviterUserId !== actingUserId && invitation.recipientUserId !== actingUserId) {
      throw new ForbiddenError("You do not have access to this invitation.");
    }
    return invitation;
  }

  private async findByTokenOrThrow(rawToken: string): Promise<AgreementInvitationRecord> {
    const invitation = await this.deps.invitations.findByTokenHash(hashOpaqueToken(rawToken));
    if (!invitation) throw new ValidationError(INVALID_INVITATION_MESSAGE);
    return invitation;
  }

  private async requireOpenInvitation(invitation: AgreementInvitationRecord): Promise<AgreementInvitationRecord> {
    if (invitation.expiresAt.getTime() <= Date.now() && OPEN_STATUSES.includes(invitation.status)) {
      await this.deps.invitations.markExpired(invitation.id);
      throw new ValidationError(INVALID_INVITATION_MESSAGE);
    }
    if (!OPEN_STATUSES.includes(invitation.status)) {
      throw new ValidationError(INVALID_INVITATION_MESSAGE);
    }
    return invitation;
  }

  private async requireInvitation(id: string): Promise<AgreementInvitationRecord> {
    const invitation = await this.deps.invitations.findById(id);
    if (!invitation) throw new ValidationError("Invitation not found.");
    return invitation;
  }

  /**
   * "prevent second-user claim" / "wrong authenticated account -> denied": once
   * `recipientUserId` is bound, only that exact account may act, ever again. Before binding,
   * requires a contact match against whatever the sender specified (email checked via the
   * accepting account's own verified email — reuses `UserEmailReader`, the same primitive
   * `StaffService.acceptInvitation`'s identical email-match uses). An invitation naming only a
   * `recipientName` (no email/phone) has nothing to verify against and is claimed by whichever
   * authenticated account presents the valid token first — still exactly "one logical claim"
   * (enforced by binding on first use), just without a contact-match layer on top.
   */
  private async requireRecipientIdentityAndBind(
    invitation: AgreementInvitationRecord,
    actingUserId: string,
    actingProfile: ProfileRef | undefined,
  ): Promise<AgreementInvitationRecord> {
    if (invitation.recipientUserId) {
      if (invitation.recipientUserId !== actingUserId) {
        throw new ForbiddenError("This invitation is not addressed to you.");
      }
      if (invitation.recipientProfileKind && invitation.recipientProfileId) {
        return invitation;
      }
      // The account was pre-resolved by email lookup at invitation-creation time (an existing
      // platform user), but no profile has been chosen yet — this is the "existing user" flow's
      // own identity-match step, not a fresh claim, so no contact-match check is needed (the
      // account match above already proves it).
      if (!actingProfile) {
        throw new ValidationError("A profile to act as is required.");
      }
      await this.authorizeParty(actingUserId, actingProfile, null);
      return this.deps.invitations.bindRecipient(invitation.id, {
        recipientUserId: actingUserId,
        recipientProfileKind: actingProfile.kind,
        recipientProfileId: actingProfile.id,
      });
    }
    if (invitation.recipientEmail) {
      const actingEmail = await this.deps.userEmails.getEmailByUserId(actingUserId);
      if (!actingEmail || normalizeEmail(actingEmail) !== invitation.recipientEmail) {
        throw new ForbiddenError("This invitation was addressed to a different contact.");
      }
    }
    if (!actingProfile) {
      throw new ValidationError("A profile to act as is required.");
    }
    await this.authorizeParty(actingUserId, actingProfile, null);
    const bound = await this.deps.invitations.bindRecipient(invitation.id, {
      recipientUserId: actingUserId,
      recipientProfileKind: actingProfile.kind,
      recipientProfileId: actingProfile.id,
    });
    await this.recordAudit(invitation.id, actingUserId, "agreement_invitation_claimed", {
      recipientProfileKind: actingProfile.kind,
    });
    return bound;
  }

  private async toPublicView(invitation: AgreementInvitationRecord): Promise<PublicInvitationView> {
    const { terms, schedule } = buildTerms({
      frequency: invitation.frequency,
      feeAllocation: invitation.feeAllocation,
      ...invitation.proposedTerms,
    });
    const totalRepaymentMinorUnits = schedule.reduce((sum, item) => sum + item.amountMinorUnits, 0);
    const display = await this.deps.profileDisplay.getDisplayName(invitation.inviterProfileKind, invitation.inviterProfileId);
    return {
      senderDisplayName: display.displayName,
      senderBusinessName: display.businessName,
      amountMinorUnits: terms.originalAmountMinorUnits,
      currency: invitation.currency,
      paymentFrequency: invitation.frequency,
      firstPaymentDate: terms.firstPaymentDate,
      numberOfPayments: terms.numberOfInstallments + 1,
      totalRepaymentMinorUnits,
      feeAllocation: invitation.feeAllocation,
      message: invitation.message,
      proposalVersion: invitation.proposalVersion,
      status: invitation.status,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  private async senderDisplayName(profile: ProfileRef): Promise<string> {
    const display = await this.deps.profileDisplay.getDisplayName(profile.kind, profile.id);
    return display.businessName ?? display.displayName;
  }

  /** Mirrors AgreementService's/RelationshipInvitationService's own private authorizeParty exactly — duplicated per this codebase's established precedent (see RelationshipInvitationService's doc comment for why: this class operates before, or independent of, any agreement/staff-scoped call that could otherwise be delegated to). */
  private async authorizeParty(actingUserId: string, party: ProfileRef, requiredCapability: Capability | null): Promise<void> {
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

  private async recordAudit(
    invitationId: string,
    actorUserId: string | null,
    action: string,
    newValue: unknown,
    previousValue: unknown = null,
  ): Promise<void> {
    await this.deps.audit.record({
      actorUserId,
      actorRole: actorUserId ? "agreement_party" : "anonymous",
      profileKind: null,
      profileId: null,
      agreementId: null,
      action,
      occurredAt: new Date().toISOString(),
      ipAddress: null,
      deviceInfo: null,
      previousValue,
      newValue,
      reason: null,
      authStrength: null,
      relatedDocumentId: null,
      relatedCaseId: invitationId,
      targetResourceType: "agreement_invitation",
      targetResourceId: invitationId,
    });
  }
}
