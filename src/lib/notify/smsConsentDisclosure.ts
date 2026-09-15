/**
 * B0-B (SMS consent / A2P compliance): the single source of truth for the disclosure text a user
 * consents to when enabling transactional SMS, and the version identifier stamped onto their consent
 * record (`sms_consent.disclosure_version`) at the moment they consent. Deliberately NOT marked
 * "server-only" — both the API route (to record which version was in effect) and the client-side
 * consent UI (to render the exact same text the record will claim they saw) import this one constant,
 * so the two can never drift apart the way two independently-maintained copies could.
 *
 * Bump `SMS_CONSENT_DISCLOSURE_VERSION` whenever `SMS_CONSENT_DISCLOSURE_TEXT` changes substantively —
 * existing consent records keep their original version untouched (see
 * `smsConsent.disclosureVersion`'s own schema doc comment), so a later wording change never
 * retroactively reinterprets what an earlier consent actually covered.
 */
export const SMS_CONSENT_DISCLOSURE_VERSION = "b0-b-2026-09-1";

/** The only consent source this pass ever records — Paid2You's own account/notification-settings web form, never a third party or an assumed/inferred source. */
export const SMS_CONSENT_SOURCE = "web_form";

export const SMS_CONSENT_LABEL = "Receive transactional text messages from Paid2You";

export const SMS_CONSENT_DISCLOSURE_TEXT =
  "By selecting this option, you agree to receive transactional text messages from Paid2You related " +
  "to your account, security, payment arrangements, payments, and other service activity. Message " +
  "frequency varies based on account activity. Message and data rates may apply. Reply STOP to opt " +
  "out or HELP for assistance. Consent is not required to use Paid2You.";
