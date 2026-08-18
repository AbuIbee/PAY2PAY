"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { DEFAULT_CHANNELS, isCriticalNotificationType, type NotificationEventType } from "@/lib/notify/eventTypes";
import type { NotificationChannel } from "@/lib/notify/notificationService";
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

function key(type: string, channel: string): string {
  return `${type}:${channel}`;
}

/**
 * PRSprint 16 (docs/prsprints/PRSPRINT_16_NOTIFICATION_PREFERENCES_DELIVERY_HISTORY.md), requirement
 * #11/#12: why SMS specifically can't be enabled right now, in plain language — never "Twilio",
 * never "provider," never a permanently hard-coded "unavailable" (this reads a fresh
 * `smsProviderAvailable` flag from the API on every load, so it starts working the moment that
 * External Blocker is resolved, with no code change here).
 */
function smsUnavailableReason(eligibility: SmsEligibility | null, providerAvailable: boolean): string | null {
  if (!providerAvailable) return "Text messages aren't available yet.";
  if (!eligibility?.phoneVerified) return "Verify a phone number to enable text messages.";
  if (eligibility.optedOut) return "You've opted out of text messages. Reply START to the last message to resume, or contact support.";
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<{
          preferences: { notificationType: string; channel: NotificationChannel; enabled: boolean }[];
          smsEligibility: SmsEligibility;
          smsProviderAvailable: boolean;
        }>("/api/notifications/preferences");
        if (!cancelled) {
          setPreferences(new Map(body.preferences.map((p) => [key(p.notificationType, p.channel), p.enabled])));
          setSmsEligibility(body.smsEligibility);
          setSmsProviderAvailable(body.smsProviderAvailable);
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
  const smsBlockedReason = smsUnavailableReason(smsEligibility, smsProviderAvailable);

  return (
    <div>
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
