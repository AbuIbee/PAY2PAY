/**
 * PRSprint 14 (docs/prsprints/PRSPRINT_14_PRODUCTION_EMAIL.md), requirements #12-17: a single shared
 * HTML wrapper applied to every outbound email by ResendEmailSender, not by the ~30 individual
 * NOTIFICATION_TEMPLATES entries (src/lib/notify/templates.ts) or the handful of services that build
 * their own body text directly (AgreementInvitationService, RelationshipInvitationService,
 * StaffService, AuthService). Those callers keep producing plain text — no template rewrite was
 * needed to get consistent branding, responsive HTML, and a plain-text fallback, since the wrapper
 * lives at the one place all of them already funnel through (`EmailSender.send`).
 *
 * Table-based layout, inline styles only, no JavaScript, no external assets (font/image URLs would be
 * one more thing to keep authenticated/available and most email clients block remote images by
 * default anyway) — the deliberately boring, maximally-compatible baseline for transactional email.
 */

const BRAND_NAME = "PAY2PAY";
const FOOTER_NOTE = "This is an automated message about your PAY2PAY account. Please do not reply directly to this email.";

/** Escapes the five HTML-significant characters. Applied to every dynamic string interpolated into the HTML body — display names, agreement stage labels, etc. are ultimately payload-derived and some (display names) are user-chosen text. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Strips characters that could be used to inject additional header-like lines into a subject (or
 * anywhere else a single-line value is expected) — CR/LF are the only characters that matter for
 * that, since this app calls a JSON provider API rather than speaking raw SMTP, but stripping them is
 * still the correct, cheap defense per requirement #17/#47 and costs nothing for the overwhelming
 * majority of values that never contain one.
 */
export function sanitizeSingleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** Converts a plain-text body (one or more lines) into escaped HTML paragraphs, preserving line breaks. */
function plainTextToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 16px 0;">${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

export interface BrandedEmailInput {
  subject: string;
  /** Plain-text body — the same string already sent as the email's `text` part. */
  body: string;
  ctaUrl?: string;
  ctaText?: string;
}

export interface BrandedEmail {
  html: string;
  text: string;
}

/** Builds both the HTML and plain-text representations of one email from a single plain-text body. */
export function renderBrandedEmail(input: BrandedEmailInput): BrandedEmail {
  const safeSubject = sanitizeSingleLine(input.subject);
  const bodyHtml = plainTextToHtml(input.body);
  const cta =
    input.ctaUrl && isSafeCtaUrl(input.ctaUrl)
      ? `<tr><td style="padding-top:8px;">
          <a href="${escapeHtml(input.ctaUrl)}" style="display:inline-block;background:#1a56db;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:6px;font-family:Arial,Helvetica,sans-serif;font-size:15px;">${escapeHtml(input.ctaText ?? "View in PAY2PAY")}</a>
        </td></tr>`
      : "";
  const ctaPlainText = input.ctaUrl && isSafeCtaUrl(input.ctaUrl) ? `\n\n${input.ctaText ?? "View in PAY2PAY"}: ${input.ctaUrl}` : "";

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
    <span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(safeSubject)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="background:#0f172a;padding:20px 24px;">
                <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.02em;">${BRAND_NAME}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 24px 8px 24px;color:#111827;font-size:15px;line-height:1.5;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:0 24px 28px 24px;">
                <table role="presentation" cellpadding="0" cellspacing="0">${cta}</table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px;background:#f9fafb;color:#6b7280;font-size:12px;line-height:1.5;border-top:1px solid #e5e7eb;">
                ${escapeHtml(FOOTER_NOTE)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { html, text: `${input.body}${ctaPlainText}` };
}

/** Only ever render a link that actually goes to our own app — never let a caller's `ctaUrl` (however unlikely) point somewhere else. */
function isSafeCtaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
