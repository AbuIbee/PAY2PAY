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
  | "relationship_payout_account_replaced";

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
]);

export function isCriticalNotificationType(type: NotificationEventType): boolean {
  return CRITICAL_NOTIFICATION_TYPES.has(type);
}

/**
 * Which channels a type fans out to by default, before per-user preference filtering (critical types
 * skip preference filtering entirely — see `notificationService.ts`). Every critical type includes
 * `sms` — the one channel most likely to reach someone immediately — in addition to `email`/`in_app`;
 * non-critical types default to `email` + `in_app` only, since SMS is the channel users are most
 * likely to find intrusive for routine contract-lifecycle updates.
 */
export const DEFAULT_CHANNELS: Record<NotificationEventType, readonly NotificationChannel[]> = {
  agreement_invitation: ["email", "in_app"],
  agreement_signed: ["email", "in_app"],
  amendment: ["email", "in_app"],
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
  relationship_invitation: ["email", "in_app"],
  relationship_accepted: ["email", "in_app"],
  relationship_declined: ["email", "in_app"],
  relationship_activated: ["email", "in_app"],
  relationship_restricted: ["email", "sms", "in_app"],
  relationship_funding_account_replaced: ["email", "sms", "in_app"],
  relationship_payout_account_replaced: ["email", "sms", "in_app"],
};

export function isNotificationEventType(value: string): value is NotificationEventType {
  return value in DEFAULT_CHANNELS;
}
