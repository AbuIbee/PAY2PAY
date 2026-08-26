"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/ui/apiFetch";
import { formatRelative } from "@/lib/ui/date";
import { notificationDeliveryStatusLabel, notificationEventLabel } from "@/lib/ui/statusLabels";
import { NOTIFICATION_TEMPLATES } from "@/lib/notify/templates";
import { isNotificationEventType } from "@/lib/notify/eventTypes";

type DeliveryStatus = "pending" | "sent" | "delivered" | "failed" | "not_sent";

interface ChannelStatus {
  channel: "email" | "sms" | "in_app";
  status: DeliveryStatus;
  failureReason: string | null;
  reason?: string;
}

interface GroupedNotification {
  groupId: string;
  notificationType: string;
  critical: boolean;
  relatedAgreementId: string | null;
  relatedPaymentAttemptId: string | null;
  relatedInvitationId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
  inAppId: string | null;
  channels: ChannelStatus[];
  archivedAt: string | null;
  actionRequired: boolean;
}

type LoadState = "loading" | "ready" | "error";
type View = "current" | "archived";

const PAGE_SIZE = 20;
const CHANNEL_LABEL: Record<ChannelStatus["channel"], string> = { email: "Email", sms: "Text message", in_app: "In-app" };

function bodyFor(record: GroupedNotification): string {
  if (isNotificationEventType(record.notificationType)) {
    return NOTIFICATION_TEMPLATES[record.notificationType](record.payload).inAppBody;
  }
  return "";
}

function titleFor(record: GroupedNotification): string {
  return notificationEventLabel[record.notificationType] ?? record.notificationType;
}

/** Only email/sms are worth a chip — in_app is the card itself, showing it again as a chip would be noise. */
function externalChannels(record: GroupedNotification): ChannelStatus[] {
  return record.channels.filter((c) => c.channel !== "in_app");
}

export function NotificationCenter() {
  const [state, setState] = useState<LoadState>("loading");
  const [view, setView] = useState<View>("current");
  const [notifications, setNotifications] = useState<GroupedNotification[]>([]);
  const [page, setPage] = useState(0);
  const [archivingAll, setArchivingAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<{ notifications: GroupedNotification[] }>(
          view === "archived" ? "/api/notifications?view=archived" : "/api/notifications",
        );
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
  }, [view]);

  function switchView(next: View) {
    setView(next);
    setPage(0);
  }

  /** Re-fetches the Current tab after "Archive all read/completed" — used only from that button handler, never from an effect. */
  async function reloadCurrent() {
    try {
      const body = await apiFetch<{ notifications: GroupedNotification[] }>("/api/notifications");
      setNotifications(body.notifications);
      setState("ready");
    } catch {
      setState("error");
    }
  }

  const pageCount = Math.max(1, Math.ceil(notifications.length / PAGE_SIZE));
  const pageItems = useMemo(
    () => notifications.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [notifications, page],
  );
  const hasArchivable = view === "current" && notifications.some((n) => !n.actionRequired && (n.inAppId === null || n.readAt !== null));

  async function handleOpen(record: GroupedNotification) {
    if (!record.inAppId || record.readAt) return;
    setNotifications((current) => current.map((n) => (n.groupId === record.groupId ? { ...n, readAt: new Date().toISOString() } : n)));
    try {
      await apiFetch("/api/notifications/read", { method: "POST", body: JSON.stringify({ id: record.inAppId }) });
    } catch {
      // Best-effort: revert the optimistic update if the server call failed.
      setNotifications((current) => current.map((n) => (n.groupId === record.groupId ? { ...n, readAt: null } : n)));
    }
  }

  async function handleArchive(record: GroupedNotification) {
    // Optimistic removal from the Current list — archiving is a one-way action from this view (no
    // "unarchive" control), so there is nothing to revert to visually even if the request fails; a
    // failed request just leaves the notification un-archived server-side and it reappears next load.
    setNotifications((current) => current.filter((n) => n.groupId !== record.groupId));
    try {
      await apiFetch("/api/notifications/archive", { method: "POST", body: JSON.stringify({ id: record.groupId }) });
    } catch {
      setNotifications((current) => [...current, record].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    }
  }

  async function handleArchiveAll() {
    setArchivingAll(true);
    try {
      await apiFetch("/api/notifications/archive-all", { method: "POST" });
      await reloadCurrent();
    } finally {
      setArchivingAll(false);
    }
  }

  const viewToggle = (
    <div className="hero__actions" style={{ marginBottom: "1rem", justifyContent: "space-between" }}>
      <div role="tablist" aria-label="Notification view" style={{ display: "flex", gap: "0.5rem" }}>
        <button type="button" role="tab" aria-selected={view === "current"} className="button button--ghost" onClick={() => switchView("current")}>
          Current
        </button>
        <button type="button" role="tab" aria-selected={view === "archived"} className="button button--ghost" onClick={() => switchView("archived")}>
          Archived
        </button>
      </div>
      {hasArchivable && (
        <button type="button" className="button button--ghost" onClick={() => void handleArchiveAll()} disabled={archivingAll}>
          {archivingAll ? "Archiving…" : "Archive all read/completed"}
        </button>
      )}
    </div>
  );

  if (state === "loading") {
    return (
      <div>
        {viewToggle}
        <div className="card-grid" aria-hidden="true">
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div>
        {viewToggle}
        <div className="form-status form-status--error" role="alert">
          Something went wrong loading your notifications. Please try again.
        </div>
      </div>
    );
  }

  if (notifications.length === 0) {
    return (
      <div>
        {viewToggle}
        <div className="empty-state">
          {view === "archived" ? (
            <>
              <h3>No archived notifications</h3>
              <p>Notifications you archive — individually or with &quot;Archive all read/completed&quot; — will appear here.</p>
            </>
          ) : (
            <>
              <h3>No notifications yet</h3>
              <p>You&apos;ll see updates about agreements, payments, and account activity here.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {viewToggle}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.75rem" }}>
        {pageItems.map((record) => {
          const unread = record.inAppId !== null && record.readAt === null;
          const deepLink = record.relatedInvitationId
            ? { href: `/connections/accept?invitationId=${record.relatedInvitationId}`, label: "Review invitation" }
            : record.relatedAgreementId
              ? { href: `/agreements/detail?id=${record.relatedAgreementId}`, label: "View agreement" }
              : record.relatedPaymentAttemptId
                ? { href: `/payments/detail?id=${record.relatedPaymentAttemptId}`, label: "View payment" }
                : null;
          const channels = externalChannels(record);

          return (
            <li key={record.groupId} className="card" style={{ borderColor: unread ? "var(--forest-700)" : undefined }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <strong style={{ fontWeight: unread ? 800 : 600 }}>{titleFor(record)}</strong>
                    {unread && view === "current" && <span className="chip chip--info">Unread</span>}
                    {record.actionRequired && view === "current" && <span className="chip chip--warning">Action required</span>}
                    {record.critical && <span className="chip chip--danger">Critical</span>}
                  </div>
                  <p style={{ margin: "0.35rem 0 0", color: "var(--ink-soft)" }}>{bodyFor(record)}</p>
                  <p style={{ margin: "0.35rem 0 0", fontSize: "0.78rem", color: "var(--ink-soft)" }}>
                    {view === "archived" && record.archivedAt ? `Archived ${formatRelative(record.archivedAt)} · ` : ""}
                    {formatRelative(record.createdAt)}
                  </p>
                  {channels.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.5rem" }}>
                      {channels.map((c) => {
                        const label = notificationDeliveryStatusLabel(c.status);
                        return (
                          <span key={c.channel} className={`chip chip--${label.tone}`} title={c.reason}>
                            {CHANNEL_LABEL[c.channel]}: {label.label}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", alignItems: "flex-end", flexShrink: 0 }}>
                  {view === "current" && unread && (
                    <button type="button" className="button button--ghost" onClick={() => void handleOpen(record)}>
                      Mark read
                    </button>
                  )}
                  {deepLink && (
                    <Link href={deepLink.href} className="button button--ghost" onClick={() => void handleOpen(record)}>
                      {deepLink.label}
                    </Link>
                  )}
                  {view === "current" && (
                    <button type="button" className="button button--ghost" onClick={() => void handleArchive(record)}>
                      Archive
                    </button>
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
