import type { NotificationChannel } from "./notificationService";

/**
 * Sprint 17 (docs/sprints/SPRINT_17_Notifications.md): this sprint's own required event list,
 * verbatim, as a closed union — `notification_event.notification_type` stays free text at the schema
 * level (Sprint 13's own deliberate choice, unchanged), but every caller in this codebase is expected
 * to go through `NotificationService.notify` with one of these values so the default-channel-set and
 * critical-classification tables below stay exhaustive and typo-proof.
 */
export type NotificationEventType =
  | "agreement_invitation"
  | "agreement_signed"
  | "amendment"
  | "payment_scheduled"
  | "payment_processing"
  | "payment_cleared"
  | "payment_failed"
  | "payment_disputed"
  | "bank_change"
  | "card_change"
  | "authorization_revoked"
  | "hardship"
  | "partial_payment"
  | "settlement"
  | "security_event"
  | "staff_permissions"
  | "payout_account_change"
  | "account_restriction"
  | "relationship_invitation"
  | "relationship_accepted"
  | "relationship_declined"
  | "relationship_activated"
  | "relationship_restricted"
  | "relationship_funding_account_replaced"
  | "relationship_payout_account_replaced"
  | "appeal_decided"
  | "agreement_invitation_response"
  | "agreement_action_required"
  | "agreement_decided"
  | "agreement_counterparty_signed"
  | "amendment_decided";

/**
 * "Critical notifications cannot be disabled" (this sprint's own instruction, verbatim). Master spec
 * doesn't itself label which of the 18 named events are critical — this classification is a
 * documented interpretive judgment call (see `docs/SPRINT_CONTROL.md`'s Sprint 17 implementation
 * notes), not something the spec enumerates: every event whose absence could cause real financial or
 * security harm if silently missed (money movement failing, an authorization/access change, a
 * security event) is critical; purely informational contract-lifecycle events are not.
 *
 * `settlement` was added to this set during this sprint's Product Owner review pass — master spec
 * §26 explicitly lists both "Approving settlements" and "Forgiving debt" among its MFA-required
 * sensitive actions, and a settlement's whole purpose is forgiving part of the balance. Missing a
 * settlement notification (e.g. a business owner who never learns a settlement is under negotiation
 * or has completed) is exactly the "real financial harm if silently missed" bar every other critical
 * type is held to. `amendment`/`hardship`/`partial_payment` remain non-critical by contrast: each
 * still requires the recipient to actively accept/counter/sign within its own workflow before taking
 * effect (Sprints 14/15's own dual-party mechanics), so missing the *notification* specifically
 * doesn't let anything happen unnoticed the way missing a settlement or a bank-account-change alert
 * would.
 *
 * Sprint 18A adds `relationship_restricted` (an admin-imposed access change — directly mirrors the
 * already-critical `account_restriction`), `relationship_funding_account_replaced` (mirrors
 * `bank_change`/`card_change` — the money-movement source is changing) and
 * `relationship_payout_account_replaced` (mirrors the already-critical `payout_account_change`) as
 * critical for the same reasons their mirrored counterparts are. `relationship_invitation`/
 * `relationship_accepted`/`relationship_declined`/`relationship_activated` remain non-critical,
 * mirroring `agreement_invitation`/`agreement_signed`: each is a cooperative-handshake or lifecycle
 * event the recipient must still separately act on (view/accept/decline, or that only unlocks further
 * activity rather than moving money itself), not money moving unnoticed.
 *
 * Sprint 18 adds `appeal_decided` as critical — master spec §30's own explicit "Notify the user by
 * email" requirement for appeal decisions, and a decision directly changes whether a restriction on
 * the user's account stays in place, the same "real financial/access harm if silently missed" bar
 * `account_restriction`/`relationship_restricted` are already held to.
 *
 * PRSprint 10 adds `agreement_invitation_response` (accept/decline/request-changes on a
 * pre-agreement proposal) as non-critical — mirrors `relationship_accepted`/`relationship_declined`:
 * a cooperative-negotiation lifecycle event the other party must still separately act on, not money
 * moving unnoticed. `agreement_invitation` (the invitation-created event) already existed (Sprint
 * 17) and is reused unchanged for the "notify an existing recognized user" path — see
 * `AgreementInvitationService.createInvitation`.
 *
 * PRSprint 13 (docs/prsprints/PRSPRINT_13_NOTIFICATION_EVENT_WIRING.md) adds four types closing a
 * real gap this PRSprint's own audit found: `AgreementService`, `AmendmentService`, and
 * `SignatureService` — the three services actually driving an agreement/amendment/signature through
 * its state machine once it exists — never called `NotificationService.notify` at all before this,
 * despite `agreement_signed`/`amendment` already existing in this taxonomy for exactly that purpose
 * (only the pre-agreement *invitation* layer, `AgreementInvitationService`/`RelationshipService`, was
 * wired). All four are non-critical, mirroring `amendment`'s own classification: each still requires
 * the recipient to actively review/sign/decide within its own workflow before anything takes effect,
 * so missing the notification specifically doesn't let anything happen unnoticed.
 * - `agreement_action_required`: the *other* party must now act (submit → debtor must acknowledge;
 *   acknowledge → creditor must decide; counter → debtor must review new terms) — mirrors
 *   `amendment`'s own "awaiting your review" framing for the pre-signature negotiation phase of a
 *   direct (non-invitation) agreement between two already-registered users.
 * - `agreement_decided`: the creditor's accept/reject decision, told to the debtor who submitted/
 *   acknowledged and is waiting to hear it.
 * - `agreement_counterparty_signed`: one party has signed and the *other* has not yet — reused for
 *   both the main agreement and an amendment's own signature step (payload `context: "agreement" |
 *   "amendment"` distinguishes copy), since "your counterparty signed, you're up" is the same
 *   user-facing moment either way, and this taxonomy avoids inventing a near-duplicate type for what
 *   amendments already do with their own sign-off.
 * - `amendment_decided`: the counterparty's accept/reject decision on a proposed amendment, and the
 *   amendment's own completion ("now applied, a new agreement version is active") — told to the
 *   proposer, mirroring `agreement_decided`'s identical shape for the main agreement.
 */
export const CRITICAL_NOTIFICATION_TYPES: ReadonlySet<NotificationEventType> = new Set<NotificationEventType>([
  "payment_failed",
  "payment_disputed",
  "bank_change",
  "card_change",
  "authorization_revoked",
  "security_event",
  "staff_permissions",
  "payout_account_change",
  "account_restriction",
  "settlement",
  "relationship_restricted",
  "relationship_funding_account_replaced",
  "relationship_payout_account_replaced",
  "appeal_decided",
]);

export function isCriticalNotificationType(type: NotificationEventType): boolean {
  return CRITICAL_NOTIFICATION_TYPES.has(type);
}

/**
 * Production follow-up (Notification cleanup + archive): distinct from `critical` — critical governs
 * "can this ever be silently disabled," this governs "does the recipient personally need to act for
 * the workflow to move forward." Drives the Notification Center's Current-view priority ordering
 * (action required > unread > recent informational) and what "Archive all read/completed" is allowed
 * to sweep up (only ever non-action-required notifications). A documented interpretive judgment call,
 * mirroring `CRITICAL_NOTIFICATION_TYPES`'s own precedent: every type whose whole purpose is "you must
 * accept/decline/counter/sign/acknowledge something now" is here; a type that only ever *reports* an
 * outcome the recipient already knows is coming (a decision they'll learn either way, a status change
 * they can't act on) is not, even if it's important enough to be critical.
 */
export const ACTION_REQUIRED_NOTIFICATION_TYPES: ReadonlySet<NotificationEventType> = new Set<NotificationEventType>([
  "agreement_invitation",
  "relationship_invitation",
  "amendment",
  "hardship",
  "partial_payment",
  "settlement",
  "agreement_action_required",
  "agreement_counterparty_signed",
]);

export function isActionRequiredNotificationType(type: NotificationEventType): boolean {
  return ACTION_REQUIRED_NOTIFICATION_TYPES.has(type);
}

/**
 * Which channels a type fans out to by default, before per-user preference filtering (critical types
 * skip preference filtering entirely — see `notificationService.ts`). Every critical type includes
 * `sms` — the one channel most likely to reach someone immediately — in addition to `email`/`in_app`;
 * non-critical types default to `email` + `in_app` only, since SMS is the channel users are most
 * likely to find intrusive for routine contract-lifecycle updates.
 */
export const DEFAULT_CHANNELS: Record<NotificationEventType, readonly NotificationChannel[]> = {
  // PRSprint 15 (docs/prsprints/PRSPRINT_15_PRODUCTION_SMS.md), requirement #13: `sms` added to
  // exactly the non-critical types that are genuinely time-sensitive/action-required — a new
  // proposal or a "your counterparty already acted, you're up next" moment, where the whole value of
  // SMS (reaching someone who isn't actively checking email/the app right now) is highest. Every
  // other non-critical type stays email+in_app only, preserving Sprint 17's own original reasoning
  // ("SMS is the channel users are most likely to find intrusive for routine contract-lifecycle
  // updates") for purely-informational "here's what happened" events (`agreement_decided`,
  // `amendment_decided`, `agreement_invitation_response`, the `relationship_accepted/declined/
  // activated` trio) and for `agreement_signed` itself (a confirmation, not something requiring
  // action from the recipient).
  agreement_invitation: ["email", "sms", "in_app"],
  agreement_signed: ["email", "in_app"],
  amendment: ["email", "sms", "in_app"],
  payment_scheduled: ["email", "in_app"],
  payment_processing: ["in_app"],
  payment_cleared: ["email", "in_app"],
  payment_failed: ["email", "sms", "in_app"],
  payment_disputed: ["email", "sms", "in_app"],
  bank_change: ["email", "sms", "in_app"],
  card_change: ["email", "sms", "in_app"],
  authorization_revoked: ["email", "sms", "in_app"],
  hardship: ["email", "in_app"],
  partial_payment: ["email", "in_app"],
  settlement: ["email", "sms", "in_app"],
  security_event: ["email", "sms", "in_app"],
  staff_permissions: ["email", "in_app"],
  payout_account_change: ["email", "sms", "in_app"],
  account_restriction: ["email", "sms", "in_app"],
  relationship_invitation: ["email", "sms", "in_app"],
  relationship_accepted: ["email", "in_app"],
  relationship_declined: ["email", "in_app"],
  relationship_activated: ["email", "in_app"],
  relationship_restricted: ["email", "sms", "in_app"],
  relationship_funding_account_replaced: ["email", "sms", "in_app"],
  relationship_payout_account_replaced: ["email", "sms", "in_app"],
  appeal_decided: ["email", "sms", "in_app"],
  agreement_invitation_response: ["email", "in_app"],
  agreement_action_required: ["email", "sms", "in_app"],
  agreement_decided: ["email", "in_app"],
  agreement_counterparty_signed: ["email", "sms", "in_app"],
  amendment_decided: ["email", "in_app"],
};

export function isNotificationEventType(value: string): value is NotificationEventType {
  return value in DEFAULT_CHANNELS;
}
