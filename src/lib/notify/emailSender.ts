/**
 * PRSprint 14 (docs/prsprints/PRSPRINT_14_PRODUCTION_EMAIL.md): widened from the original Sprint 17
 * `send(input): Promise<void>` shape to carry a call-to-action link (rendered as a branded button by
 * the real implementation, not assembled ad hoc by each caller — requirement #12/13/14, "separate
 * templates from delivery infrastructure") and to return the provider's own message id, so a caller
 * that persists delivery evidence (NotificationService.deliver) has something to store. `ctaUrl`/
 * `ctaText` are optional — the handful of callers that don't have a specific link to offer (or that
 * already embed one in `body`, a pre-existing pattern this PRSprint deliberately did not disturb) can
 * omit them. `providerMessageId` is `null` for ConsoleEmailSender (nothing was actually sent to a
 * provider) and for any real send the provider didn't return an id for.
 */
export interface EmailSender {
  send(input: { to: string; subject: string; body: string; ctaUrl?: string; ctaText?: string }): Promise<{ providerMessageId: string | null }>;
}
