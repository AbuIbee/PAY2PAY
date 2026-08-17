"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatDateTime } from "@/lib/ui/date";

type DeliveryStatus = "pending" | "sent" | "delivered" | "failed";

interface SmsNotificationEvent {
  id: string;
  recipientUserId: string;
  notificationType: string;
  status: DeliveryStatus;
  attemptCount: number;
  failureReason: string | null;
  providerMessageId: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  nextRetryAt: string | null;
}

const STATUS_TONE: Record<DeliveryStatus, string> = {
  pending: "neutral",
  sent: "info",
  delivered: "success",
  failed: "danger",
};

/** PRSprint 15 (docs/prsprints/PRSPRINT_15_PRODUCTION_SMS.md), requirement #27: the SMS-channel sibling of AdminEmailDelivery.tsx — same shape, same masking rules (never a phone number, only recipientUserId). */
export function AdminSmsDelivery() {
  const [events, setEvents] = useState<SmsNotificationEvent[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  async function load() {
    try {
      const body = await apiFetch<{ events: SmsNotificationEvent[] }>("/api/admin/notifications/sms");
      setEvents(body.events);
      setState("ready");
    } catch {
      setState("error");
    }
  }

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, []);

  async function handleRetry(id: string) {
    setActionError(null);
    setRetryingId(id);
    try {
      await apiFetch("/api/admin/notifications/sms/retry", { method: "POST", body: JSON.stringify({ notificationEventId: id }) });
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Something went wrong retrying this message.");
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="card">
      <div className="card__header">
        <h2>Recent SMS deliveries</h2>
      </div>
      {state === "loading" && (
        <div aria-hidden="true">
          <div className="skeleton skeleton--line" />
          <div className="skeleton skeleton--line" />
        </div>
      )}
      {state === "error" && (
        <div className="form-status form-status--error" role="alert">
          Something went wrong loading SMS delivery events. Please try again.
        </div>
      )}
      {actionError && (
        <p className="field-error" role="alert">
          {actionError}
        </p>
      )}
      {state === "ready" && events.length === 0 && (
        <div className="empty-state">
          <h3>No SMS events yet</h3>
        </div>
      )}
      {state === "ready" && events.length > 0 && (
        <div className="table-wrap table-wrap--responsive-cards">
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Recipient</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Failure</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td data-label="Type">{event.notificationType}</td>
                  <td data-label="Recipient">{event.recipientUserId}</td>
                  <td data-label="Status">
                    <span className={`chip chip--${STATUS_TONE[event.status]}`}>{event.status}</span>
                  </td>
                  <td data-label="Attempts">{event.attemptCount}</td>
                  <td data-label="Failure">{event.failureReason ?? "—"}</td>
                  <td data-label="Created">{formatDateTime(event.createdAt)}</td>
                  <td data-label="">
                    {event.status === "failed" && (
                      <button type="button" className="button button--ghost" disabled={retryingId === event.id} onClick={() => void handleRetry(event.id)}>
                        {retryingId === event.id ? "Retrying…" : "Retry"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
