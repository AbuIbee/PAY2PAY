/**
 * PRSprint 15 (docs/prsprints/PRSPRINT_15_PRODUCTION_SMS.md): widened from the original Sprint 17
 * `send(input): Promise<void>` shape to return the provider's own message id, mirroring
 * `EmailSender`'s identical PRSprint 14 change — a caller that persists delivery evidence
 * (NotificationService.deliver) has something to store. Unlike email, there is no separate
 * `ctaUrl`/`ctaText` — a link either fits directly in `body` (this codebase's own SMS templates
 * already embed one where relevant) or it doesn't belong in an SMS at all; there is no HTML wrapper to
 * turn a bare URL into a styled button the way there is for email.
 */
export interface SmsSender {
  send(input: { to: string; body: string }): Promise<{ providerMessageId: string | null }>;
}
