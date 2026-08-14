"use client";

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

function key(type: string, channel: string): string {
  return `${type}:${channel}`;
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
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<{ preferences: { notificationType: string; channel: NotificationChannel; enabled: boolean }[] }>(
          "/api/notifications/preferences",
        );
        if (!cancelled) {
          setPreferences(new Map(body.preferences.map((p) => [key(p.notificationType, p.channel), p.enabled])));
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

  return (
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
                      const checked = critical ? true : (preferences.get(k) ?? true);
                      const inputId = `pref-${type}-${channel}`;
                      return (
                        <label key={channel} htmlFor={inputId} className="checkbox-field" style={{ margin: 0 }}>
                          <input
                            id={inputId}
                            type="checkbox"
                            checked={checked}
                            disabled={critical || pendingKey === k}
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
  );
}
