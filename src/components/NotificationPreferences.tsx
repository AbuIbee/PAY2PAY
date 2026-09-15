"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { DEFAULT_CHANNELS, isCriticalNotificationType, type NotificationEventType } from "@/lib/notify/eventTypes";
import type { NotificationChannel } from "@/lib/notify/notificationService";
import { SMS_CONSENT_DISCLOSURE_TEXT, SMS_CONSENT_LABEL } from "@/lib/notify/smsConsentDisclosure";
import { notificationEventLabel } from "@/lib/ui/statusLabels";

type LoadState = "loading" | "ready" | "error";

const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  email: "Email",
  sms: "Text message",
  in_app: "In-app",
};

interface SmsEligibility {
  phoneVerified: boolean;
  maskedPhone: string | null;
  optedOut: boolean;
}

interface SmsConsentStatus {
  active: boolean;
  effectiveActive: boolean;
  /**
   * B0-B-001 blocker correction: true when consent is still recorded active but the user's current
   * verified phone no longer matches the phone that was actually consented-to (e.g. they replaced
   * their verified number after opting in). `effectiveActive` already reflects the safe outcome
   * (false) — this flag exists purely so the UI can explain *why* to the user instead of silently
   * showing the same generic "off" copy as someone who never consented at all.
   */
  phoneChangedSinceConsent: boolean;
  eligibility: SmsEligibility;
}

function key(type: string, channel: string): string {
  return `${type}:${channel}`;
}

/**
 * PRSprint 16 (docs/prsprints/PRSPRINT_16_NOTIFICATION_PREFERENCES_DELIVERY_HISTORY.md), requirement
 * #11/#12: why SMS specifically can't be enabled right now, in plain language — never "Twilio",
 * never "provider," never a permanently hard-coded "unavailable" (this reads a fresh
 * `smsProviderAvailable` flag from the API on every load, so it starts working the moment that
 * External Blocker is resolved, with no code change here).
 *
 * B0-B addition: a user who has never turned on the master "Receive transactional text messages"
 * control above (or who has actively opted out via STOP — `effectiveActive` already reconciles that,
 * see NotificationService.getSmsConsentStatus's own doc comment) sees the same honest "unavailable"
 * treatment on every individual per-type SMS checkbox below, rather than a checkbox that renders as
 * usable but can never actually deliver.
 *
 * B0-B-001 blocker correction: a phone-changed-since-consent state gets its own explicit copy —
 * telling the user their consent no longer applies because they changed numbers is materially
 * different from "you never turned this on," and the required behavior is that they see SMS as OFF
 * and requiring a fresh opt-in, not a silent, unexplained toggle flip.
 */
function smsUnavailableReason(
  eligibility: SmsEligibility | null,
  providerAvailable: boolean,
  consentEffectiveActive: boolean,
  phoneChangedSinceConsent: boolean,
): string | null {
  if (!providerAvailable) return "Text messages aren't available yet.";
  if (!eligibility?.phoneVerified) return "Verify a phone number to enable text messages.";
  if (eligibility.optedOut) return "You've opted out of text messages. Reply START to the last message to resume, or contact support.";
  if (phoneChangedSinceConsent) return "Your phone number changed since you last agreed to text messages. Turn this on again to keep receiving them.";
  if (!consentEffectiveActive) return "Turn on transactional text messages above to use this.";
  return null;
}

/**
 * Sprint 18B / Sprint 17: "Critical notifications cannot be disabled" — the
 * backend already silently no-ops an attempted opt-out for a critical type
 * (NotificationService.setPreference), but this UI must not let a user
 * believe they successfully disabled one, so critical-type toggles are
 * rendered checked and disabled, never merely defaulted.
 */
export function NotificationPreferences() {
  const [state, setState] = useState<LoadState>("loading");
  const [preferences, setPreferences] = useState<Map<string, boolean>>(new Map());
  const [smsEligibility, setSmsEligibility] = useState<SmsEligibility | null>(null);
  const [smsProviderAvailable, setSmsProviderAvailable] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [smsConsent, setSmsConsent] = useState<SmsConsentStatus | null>(null);
  const [smsConsentPending, setSmsConsentPending] = useState(false);
  const [smsConsentError, setSmsConsentError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [prefsBody, consentBody] = await Promise.all([
          apiFetch<{
            preferences: { notificationType: string; channel: NotificationChannel; enabled: boolean }[];
            smsEligibility: SmsEligibility;
            smsProviderAvailable: boolean;
          }>("/api/notifications/preferences"),
          apiFetch<SmsConsentStatus>("/api/notifications/sms-consent"),
        ]);
        if (!cancelled) {
          setPreferences(new Map(prefsBody.preferences.map((p) => [key(p.notificationType, p.channel), p.enabled])));
          setSmsEligibility(prefsBody.smsEligibility);
          setSmsProviderAvailable(prefsBody.smsProviderAvailable);
          setSmsConsent(consentBody);
          setState("ready");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleToggle(type: NotificationEventType, channel: NotificationChannel, enabled: boolean) {
    const k = key(type, channel);
    setPendingKey(k);
    setPreferences((current) => new Map(current).set(k, enabled));
    try {
      await apiFetch("/api/notifications/preferences", {
        method: "POST",
        body: JSON.stringify({ notificationType: type, channel, enabled }),
      });
    } catch {
      setPreferences((current) => new Map(current).set(k, !enabled));
    } finally {
      setPendingKey(null);
    }
  }

  /**
   * B0-B: the master SMS consent toggle. `enabled` is always the user's own explicit, current click —
   * never preselected, never inferred. On failure the checkbox reverts (mirrors handleToggle's
   * identical optimistic-update-then-revert pattern) rather than silently claiming a state that was
   * never actually persisted.
   */
  async function handleSmsConsentToggle(enabled: boolean) {
    setSmsConsentPending(true);
    setSmsConsentError(false);
    const previous = smsConsent;
    setSmsConsent((current) => (current ? { ...current, active: enabled, effectiveActive: enabled } : current));
    try {
      await apiFetch("/api/notifications/sms-consent", { method: "POST", body: JSON.stringify({ enabled }) });
      const fresh = await apiFetch<SmsConsentStatus>("/api/notifications/sms-consent");
      setSmsConsent(fresh);
    } catch {
      setSmsConsent(previous);
      setSmsConsentError(true);
    } finally {
      setSmsConsentPending(false);
    }
  }

  if (state === "loading") {
    return (
      <div aria-hidden="true">
        <div className="skeleton skeleton--line" style={{ width: "60%" }} />
        <div className="skeleton skeleton--line" style={{ width: "40%" }} />
        <div className="skeleton skeleton--line" style={{ width: "50%" }} />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="form-status form-status--error" role="alert">
        Something went wrong loading your notification preferences. Please try again.
      </div>
    );
  }

  const entries = Object.entries(DEFAULT_CHANNELS) as [NotificationEventType, readonly NotificationChannel[]][];
  const smsConsentEffectiveActive = smsConsent?.effectiveActive ?? false;
  const smsPhoneChangedSinceConsent = smsConsent?.phoneChangedSinceConsent ?? false;
  const smsBlockedReason = smsUnavailableReason(smsEligibility, smsProviderAvailable, smsConsentEffectiveActive, smsPhoneChangedSinceConsent);
  // The master control itself is disabled — not merely unchecked — until there is a real destination
  // phone and the provider is actually live; matches "do not allow SMS consent to become meaningfully
  // active without a usable mobile/contact phone number" (this pass's own instruction, verbatim).
  const consentControlDisabled = !smsProviderAvailable || !smsEligibility?.phoneVerified || smsConsentPending;

  return (
    <div>
      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <label htmlFor="sms-consent-toggle" className="checkbox-field" style={{ alignItems: "flex-start", gap: "0.6rem" }}>
          <input
            id="sms-consent-toggle"
            type="checkbox"
            checked={smsConsentEffectiveActive}
            disabled={consentControlDisabled}
            aria-disabled={consentControlDisabled}
            onChange={(event) => void handleSmsConsentToggle(event.target.checked)}
          />
          <span>{SMS_CONSENT_LABEL}</span>
        </label>
        <p style={{ color: "var(--ink-soft)", fontSize: "0.85rem", marginTop: "0.5rem", marginBottom: 0 }}>
          {SMS_CONSENT_DISCLOSURE_TEXT} See our <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy Policy</Link>.
        </p>
        {!smsEligibility?.phoneVerified && smsProviderAvailable && (
          <p style={{ color: "var(--ink-soft)", fontSize: "0.85rem", marginTop: "0.5rem", marginBottom: 0 }}>
            <Link href="/account/security">Verify a phone number</Link> to turn this on.
          </p>
        )}
        {smsConsentError && (
          <p className="field-error" role="alert" style={{ marginTop: "0.5rem" }}>
            Something went wrong updating your text message preference. Please try again.
          </p>
        )}
      </div>
      {smsBlockedReason && (
        <div className="form-status form-status--info" role="status" style={{ marginBottom: "1rem" }}>
          <strong>Text messages: </strong>
          {smsBlockedReason}
          {!smsEligibility?.phoneVerified && smsProviderAvailable && (
            <>
              {" "}
              <Link href="/account/security">Verify a phone number</Link>
            </>
          )}
        </div>
      )}
      {smsEligibility?.maskedPhone && !smsBlockedReason && (
        <p style={{ color: "var(--ink-soft)", fontSize: "0.85rem", marginBottom: "1rem" }}>
          Text messages go to your verified number ending in {smsEligibility.maskedPhone.slice(-2)}.
        </p>
      )}
      <div className="table-wrap table-wrap--responsive-cards">
        <table className="table">
          <thead>
            <tr>
              <th>Notification</th>
              <th>Channels</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([type, channels]) => {
              const critical = isCriticalNotificationType(type);
              return (
                <tr key={type}>
                  <td data-label="Notification">
                    {notificationEventLabel[type] ?? type}
                    {critical && (
                      <span className="chip chip--danger" style={{ marginLeft: "0.5rem" }}>
                        Required
                      </span>
                    )}
                  </td>
                  <td data-label="Channels">
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
                      {channels.map((channel) => {
                        const k = key(type, channel);
                        // Eligibility takes priority over "critical" for SMS specifically — a
                        // critical type's SMS row is always *attempted* server-side regardless of
                        // eligibility (resolveChannels never filters critical types), but showing a
                        // checked "Required" box for a channel that structurally cannot be delivered
                        // right now (no verified phone, opted out, provider not yet live) would be
                        // exactly the "misleading enabled toggle" requirement #11 prohibits.
                        const smsUnavailable = channel === "sms" && smsBlockedReason !== null;
                        const checked = smsUnavailable ? false : critical ? true : (preferences.get(k) ?? true);
                        const disabled = smsUnavailable || critical || pendingKey === k;
                        const inputId = `pref-${type}-${channel}`;
                        return (
                          <label
                            key={channel}
                            htmlFor={inputId}
                            className="checkbox-field"
                            style={{ margin: 0 }}
                            title={smsUnavailable ? (smsBlockedReason ?? undefined) : undefined}
                          >
                            <input
                              id={inputId}
                              type="checkbox"
                              checked={checked}
                              disabled={disabled}
                              aria-disabled={disabled}
                              onChange={(event) => void handleToggle(type, channel, event.target.checked)}
                            />
                            {CHANNEL_LABEL[channel]}
                          </label>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
