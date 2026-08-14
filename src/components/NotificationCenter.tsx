"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatRelative } from "@/lib/ui/date";
import { notificationEventLabel } from "@/lib/ui/statusLabels";
import { NOTIFICATION_TEMPLATES } from "@/lib/notify/templates";
import { isNotificationEventType } from "@/lib/notify/eventTypes";

interface NotificationRecord {
  id: string;
  notificationType: string;
  critical: boolean;
  relatedAgreementId: string | null;
  relatedPaymentAttemptId: string | null;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

type LoadState = "loading" | "ready" | "error";

const PAGE_SIZE = 20;

function bodyFor(record: NotificationRecord): string {
  if (isNotificationEventType(record.notificationType)) {
    return NOTIFICATION_TEMPLATES[record.notificationType](record.payload).inAppBody;
  }
  return "";
}

function titleFor(record: NotificationRecord): string {
  return notificationEventLabel[record.notificationType] ?? record.notificationType;
}

export function NotificationCenter() {
  const [state, setState] = useState<LoadState>("loading");
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<{ notifications: NotificationRecord[] }>("/api/notifications");
        if (!cancelled) {
          setNotifications(body.notifications);
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

  const pageCount = Math.max(1, Math.ceil(notifications.length / PAGE_SIZE));
  const pageItems = useMemo(
    () => notifications.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [notifications, page],
  );

  async function handleOpen(record: NotificationRecord) {
    if (record.readAt) return;
    setNotifications((current) => current.map((n) => (n.id === record.id ? { ...n, readAt: new Date().toISOString() } : n)));
    try {
      await apiFetch("/api/notifications/read", { method: "POST", body: JSON.stringify({ id: record.id }) });
    } catch {
      // Best-effort: revert the optimistic update if the server call failed.
      setNotifications((current) => current.map((n) => (n.id === record.id ? { ...n, readAt: null } : n)));
    }
  }

  if (state === "loading") {
    return (
      <div className="card-grid" aria-hidden="true">
        <div className="skeleton skeleton--card" />
        <div className="skeleton skeleton--card" />
        <div className="skeleton skeleton--card" />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="form-status form-status--error" role="alert">
        Something went wrong loading your notifications. Please try again.
      </div>
    );
  }

  if (notifications.length === 0) {
    return (
      <div className="empty-state">
        <h3>No notifications yet</h3>
        <p>You&apos;ll see updates about agreements, payments, and account activity here.</p>
      </div>
    );
  }

  return (
    <div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.75rem" }}>
        {pageItems.map((record) => {
          const unread = record.readAt === null;
          const deepLink = record.relatedAgreementId
            ? { href: `/agreements/detail?id=${record.relatedAgreementId}`, label: "View agreement" }
            : record.relatedPaymentAttemptId
              ? { href: `/payments/detail?id=${record.relatedPaymentAttemptId}`, label: "View payment" }
              : null;

          return (
            <li key={record.id} className="card" style={{ borderColor: unread ? "var(--forest-700)" : undefined }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <strong style={{ fontWeight: unread ? 800 : 600 }}>{titleFor(record)}</strong>
                    {unread && <span className="chip chip--info">Unread</span>}
                    {record.critical && <span className="chip chip--danger">Critical</span>}
                  </div>
                  <p style={{ margin: "0.35rem 0 0", color: "var(--ink-soft)" }}>{bodyFor(record)}</p>
                  <p style={{ margin: "0.35rem 0 0", fontSize: "0.78rem", color: "var(--ink-soft)" }}>
                    {formatRelative(record.createdAt)}
                  </p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", alignItems: "flex-end", flexShrink: 0 }}>
                  {unread && (
                    <button type="button" className="button button--ghost" onClick={() => void handleOpen(record)}>
                      Mark read
                    </button>
                  )}
                  {deepLink && (
                    <Link href={deepLink.href} className="button button--ghost" onClick={() => void handleOpen(record)}>
                      {deepLink.label}
                    </Link>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {pageCount > 1 && (
        <nav className="pagination" aria-label="Notifications pages">
          <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
            Previous
          </button>
          {Array.from({ length: pageCount }, (_, i) => (
            <button key={i} type="button" aria-current={page === i} onClick={() => setPage(i)}>
              {i + 1}
            </button>
          ))}
          <button type="button" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page === pageCount - 1}>
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
